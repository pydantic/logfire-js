import { gzip, gzipSync, strToU8 } from 'fflate'

import { isUserActivityEvent, resolveFlushInterval } from './activity'
import { computeChunkMeta, normalizeReplayUser } from './extract'
import { safeSessionStorage } from './session'
import { CHUNK_ENVELOPE_VERSION, EventType } from './types'
import type { ChunkEnvelope, ReplayUser, ResolvedSessionReplayConfig, RrwebEvent, SessionAttributes } from './types'
import { ReplayUploadError } from './uploadError'
import type { ReplayUploadFailureReason } from './uploadError'

export const SEQ_STORAGE_KEY = 'lf_session_replay_seq'

const REPLAY_UPLOAD_TIMEOUT_MS = 10_000
// Close to the previous worst case (3 attempts x 10s timeout) so flush() and
// page-level waits keep their existing upper bound.
const RETRY_BUDGET_MS = 30_000
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 8_000
const MAX_QUEUED_BYTES = 2_000_000
// A persistently failing endpoint would otherwise trigger a DOM snapshot on every flush.
const RESYNC_MIN_INTERVAL_MS = 60_000
const MAX_KEEPALIVE_RESERVED_BYTES = 48_000
const MAX_KEEPALIVE_RAW_BYTES = 1_000_000
// Events compress unevenly, so a prefix sized from the batch's average ratio can still overshoot.
const KEEPALIVE_PACKING_HEADROOM = 0.9
// Below this, more pagehide chunks would add requests and compression passes for little data.
const MIN_KEEPALIVE_CHUNK_BYTES = MAX_KEEPALIVE_RESERVED_BYTES / 10
interface Compression {
  gzip: typeof gzip
  gzipSync: typeof gzipSync
}

interface ChunkIdentity {
  distinctId: string
  user: ReplayUser | undefined
}

interface PreparedUpload {
  body: Uint8Array
  requestKeepalive: boolean
  reservedBytes: number
  seq: number
  sessionId: string
}

interface LifecycleChunk {
  events: RrwebEvent[]
  eventBytes: number
  body?: Uint8Array
}

interface QueuedUpload {
  body: Uint8Array | undefined
  done: Promise<void>
  events: RrwebEvent[] | undefined
  hasFullSnapshot: boolean
  identity: ChunkIdentity
  reachedFetch: boolean
  attempting: boolean
  background: boolean
  pagehide: boolean
  // Compressed while the chunk was split. Valid only while `events` is still the same array.
  prepared: LifecycleChunk | undefined
  resolve: () => void
  retainedBytes: number
  seq: number
  sessionId: string
  settled: boolean
}

interface UploadFailure {
  cause: unknown
  reason: ReplayUploadFailureReason
  status?: number | undefined
}

interface ReplayTransportOptions {
  holdUntilActivity?: boolean
  takeFullSnapshot?: () => void
  sequenceRecord?: SequenceRecordBinding
  /**
   * Buffer events but reserve no sequence and send nothing until `bind()` attaches the recording's
   * shared sequence record. The recording starts at once, while its lock is still pending.
   */
  awaitBinding?: boolean
  /**
   * Called once, after the server rejects a chunk with a status that later chunks would also get,
   * such as a revoked token. The transport sends nothing more.
   */
  onPermanentRejection?: () => void
}

/**
 * The shared sequence record of the recording that this transport writes. The transport starts at
 * `initialSeq`, and it queues a chunk only after `write` confirms the chunk's next sequence.
 */
export interface SequenceRecordBinding {
  initialSeq: number
  write(seq: number): boolean
  /** Called once, after the first failed write. The transport sends nothing more. */
  onFailure(): void
}

const DEFAULT_COMPRESSION: Compression = { gzip, gzipSync }

export class ReplayTransport {
  private buffer: RrwebEvent[] = []
  private bufferHasFullSnapshot = false
  private pendingBytes = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextFlushAt: number | undefined
  private lastUserActivityAt: number
  private readonly startedAt: number
  private started = false
  private held: boolean
  private heldBufferIncomplete = false
  private minimumBufferIncomplete = false
  private minimumDurationSatisfied = false
  private firstObservedTimestamp: number | undefined
  private lastObservedTimestamp: number | undefined
  private refreshingMinimumSnapshot = false
  private mode: 'full' | 'buffer'
  private readonly queue: QueuedUpload[] = []
  private retainedBytes = 0
  private activeUpload: QueuedUpload | undefined
  private drainPromise: Promise<void> | undefined
  private draining = false
  private readonly pagehideUploads = new Set<QueuedUpload>()
  private readonly lifecycleFlights = new Set<Promise<void>>()
  private closed = false
  private shuttingDown = false
  private wakeRetry: (() => void) | undefined
  private readonly retryAbort = new AbortController()
  private readonly deadlineAbort = new AbortController()
  private resyncPending = false
  private resyncTimer: ReturnType<typeof setTimeout> | undefined
  private lastResyncAt: number | undefined
  private reservedKeepaliveBytes = 0
  private asyncCompressionAvailable = true
  private readonly config: ResolvedSessionReplayConfig
  private readonly compression: Compression
  private readonly storage: Storage | null
  private readonly sessionId: string
  private readonly sessionAttributes: SessionAttributes
  private readonly takeFullSnapshot: (() => void) | undefined
  private sequenceRecord: SequenceRecordBinding | undefined
  private sequenceRecordFailed = false
  private awaitingBinding: boolean
  private bindingBufferIncomplete = false
  private readonly onPermanentRejection: (() => void) | undefined
  private permanentlyRejected = false

  constructor(
    config: ResolvedSessionReplayConfig,
    sessionId: string,
    mode: 'full' | 'buffer',
    storage: Storage | null = safeSessionStorage(),
    compression: Compression = DEFAULT_COMPRESSION,
    sessionAttributes: SessionAttributes = {},
    options: ReplayTransportOptions = {}
  ) {
    this.config = config
    this.sessionId = sessionId
    this.sessionAttributes = Object.freeze({ ...sessionAttributes })
    this.mode = mode
    this.storage = storage
    this.compression = compression
    this.held = options.holdUntilActivity === true && mode === 'full'
    this.takeFullSnapshot = options.takeFullSnapshot
    this.sequenceRecord = options.sequenceRecord
    this.awaitingBinding = options.awaitBinding === true
    this.onPermanentRejection = options.onPermanentRejection
    this.minimumDurationSatisfied = config.minSessionDurationMs === 0
    this.seq = options.sequenceRecord?.initialSeq ?? this.readPersistedSequence() ?? 0
    this.startedAt = this.config.now()
    this.lastUserActivityAt = this.startedAt
  }

  start(): void {
    if (this.started || this.mode !== 'full') {
      return
    }
    this.started = true
    this.scheduleFlush()
  }

  add(event: RrwebEvent): void {
    if (!this.minimumDurationSatisfied) {
      // Events rejected by the byte cap still establish observed session duration.
      // A fresh snapshot restores the replay anchor before any retained prefix ships.
      this.firstObservedTimestamp ??= event.timestamp
      this.lastObservedTimestamp = Math.max(this.lastObservedTimestamp ?? event.timestamp, event.timestamp)
    }
    if (isUserActivityEvent(event)) {
      this.lastUserActivityAt = this.config.now()
    }
    const eventBytes = estimateBytes(event)
    if (this.resyncPending) {
      this.addDuringResync(event, eventBytes)
      return
    }
    if (this.refreshingMinimumSnapshot) {
      this.buffer.push(event)
      this.pendingBytes += eventBytes
      return
    }
    const enforcingMinimum = !this.minimumDurationSatisfied
    if (this.mode === 'buffer' || this.held || enforcingMinimum || this.awaitingBinding) {
      if (event.type === EventType.Meta) {
        this.buffer = [event]
        this.bufferHasFullSnapshot = false
        this.minimumBufferIncomplete = false
        this.pendingBytes = eventBytes
        if (enforcingMinimum) {
          if (this.mode === 'full') {
            this.firstObservedTimestamp = event.timestamp
          }
          this.finishMinimumBufferingEvent()
        }
        return
      }
      if (event.type === EventType.FullSnapshot) {
        const retainedMeta =
          !this.bufferHasFullSnapshot && this.buffer.length === 1 && this.buffer[0]?.type === EventType.Meta ? this.buffer[0] : undefined
        this.buffer = retainedMeta === undefined ? [event] : [retainedMeta, event]
        this.bufferHasFullSnapshot = true
        this.pendingBytes = eventBytes + (retainedMeta === undefined ? 0 : estimateBytes(retainedMeta))
        this.heldBufferIncomplete = false
        this.minimumBufferIncomplete = false
        if (enforcingMinimum) {
          if (this.mode === 'full') {
            this.firstObservedTimestamp = retainedMeta?.timestamp ?? event.timestamp
          }
          this.finishMinimumBufferingEvent()
        }
        return
      }
      // Incremental rrweb events are only useful after a full-snapshot anchor.
      // Keep the earliest contiguous prefix so later events never depend on a
      // state transition that was trimmed from the buffer.
      if (!this.bufferHasFullSnapshot || eventBytes > this.config.maxBufferBytes) {
        this.heldBufferIncomplete ||= this.held
        this.bindingBufferIncomplete ||= this.awaitingBinding
        this.minimumBufferIncomplete ||= enforcingMinimum
        if (enforcingMinimum) {
          this.finishMinimumBufferingEvent()
        }
        return
      }
      if (this.pendingBytes + eventBytes > this.config.maxBufferBytes) {
        this.heldBufferIncomplete ||= this.held
        this.bindingBufferIncomplete ||= this.awaitingBinding
        this.minimumBufferIncomplete ||= enforcingMinimum
        if (enforcingMinimum) {
          this.finishMinimumBufferingEvent()
        }
        return
      }
    }

    // A checkpoint starts a fresh chunk with its Meta and FullSnapshot pair.
    if (event.type === EventType.Meta && this.mode === 'full' && this.buffer.length > 0) {
      this.flushAndReport()
    }
    this.buffer.push(event)
    this.pendingBytes += eventBytes
    if (enforcingMinimum && this.minimumDurationReached()) {
      this.flushAndReport()
      return
    }

    if (this.mode === 'full' && this.pendingBytes >= this.config.maxBufferBytes && event.type !== EventType.Meta) {
      this.flushAndReport()
    } else {
      this.scheduleFlush()
    }
  }

  // After a lost chunk, incremental events would apply to DOM state the server
  // never received. Only a new Meta + FullSnapshot anchor restarts the stream.
  private addDuringResync(event: RrwebEvent, eventBytes: number): void {
    if (event.type === EventType.Meta) {
      this.buffer = [event]
      this.pendingBytes = eventBytes
      return
    }
    if (event.type !== EventType.FullSnapshot) {
      return
    }
    const meta = this.buffer.length === 1 && this.buffer[0]?.type === EventType.Meta ? this.buffer[0] : undefined
    this.buffer = meta === undefined ? [event] : [meta, event]
    this.pendingBytes = eventBytes + (meta === undefined ? 0 : estimateBytes(meta))
    this.resyncPending = false
    this.clearResyncTimer()
    if (this.pendingBytes >= this.config.maxBufferBytes) {
      this.flushAndReport()
    } else {
      this.scheduleFlush()
    }
  }

  async triggerFlush(): Promise<void> {
    if (this.mode === 'buffer') {
      if (!this.bufferHasFullSnapshot) {
        this.buffer = []
        this.pendingBytes = 0
      }
      this.mode = 'full'
      this.start()
    }
    return this.flush()
  }

  async flush(options: { keepalive?: boolean; background?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return
    }
    if (options.keepalive !== true) {
      return this.flushInternal(options)
    }
    // Hidden-tab work may still be queued behind a slow request. Give its
    // unsent tail a final attempt before the document freezes, without duplicating
    // the active upload or a previous pagehide attempt.
    if (this.activeUpload !== undefined) {
      this.activeUpload.background = true
      this.activeUpload.pagehide = true
    }
    const pending = this.queue.filter((upload) => (upload !== this.activeUpload || !upload.attempting) && !this.pagehideUploads.has(upload))
    for (const upload of pending) {
      this.pagehideUploads.add(upload)
      upload.background = true
    }
    // Transfer preparation and sleeping retries to the final pass. Their drain
    // waits for completion rather than racing a duplicate attempt. Reserve bodies
    // synchronously in sequence order, before the buffered tail claims capacity.
    this.wakeRetry?.()
    const finalAttempts = this.trackLifecycle(Promise.all(pending.map(async (upload) => this.finalAttempt(upload))).then(() => undefined))
    await Promise.all([this.flushInternal(options), finalAttempts])
  }

  private async flushInternal(options: { keepalive?: boolean; background?: boolean } = {}): Promise<void> {
    if (this.closed || this.mode === 'buffer' || this.held || this.awaitingBinding || this.buffer.length === 0) {
      return
    }
    if (!this.minimumDurationReached()) {
      return
    }
    this.clearScheduledFlush()
    // Overflow mutations were dropped to keep the pre-minimum buffer bounded.
    // A new snapshot restores a valid rrweb state chain before the buffer ships.
    if (this.minimumBufferIncomplete && !this.refreshMinimumBuffer()) {
      return
    }
    this.minimumDurationSatisfied = true

    const events = this.buffer
    const eventBytes = this.pendingBytes
    this.buffer = []
    this.bufferHasFullSnapshot = false
    this.minimumBufferIncomplete = false
    this.pendingBytes = 0
    const sessionId = this.sessionId
    // Queued uploads can wait behind earlier ones, so identity is captured with
    // the events it describes rather than when the upload is finally sent.
    const identity = this.snapshotIdentity()

    if (options.keepalive === true) {
      // A pagehide keepalive must start before the browser freezes the
      // page, even when an ordinary upload is still awaiting its response.
      const eventChunks = this.splitKeepaliveEventChunks(
        events,
        identity,
        Math.max(0, MAX_KEEPALIVE_RESERVED_BYTES - this.reservedKeepaliveBytes)
      )
      const seq = this.allocateSeq(eventChunks.length)
      if (seq === undefined) {
        return
      }
      await this.trackLifecycle(this.deliverLifecycle(eventChunks, seq, sessionId, identity))
      return
    }

    if (options.background === true) {
      // A hidden tab can be frozen or discarded without a pagehide. Chunks that fit the
      // keepalive budget let each request outlive the page, and the queue keeps their order
      // and retries. Sequences are allocated in chunk order, matching the prepared envelopes.
      const uploads: QueuedUpload[] = []
      for (const chunk of this.splitKeepaliveEventChunks(events, identity)) {
        const upload = this.enqueue(chunk.events, chunk.eventBytes, sessionId, identity, true, chunk)
        if (upload === undefined) {
          break
        }
        uploads.push(upload)
      }
      await Promise.all(uploads.map(async (upload) => upload.done))
      return
    }

    const upload = this.enqueue(events, eventBytes, sessionId, identity)
    await upload?.done
  }

  async shutdown(options: { keepalive?: boolean } = {}): Promise<void> {
    this.started = false
    this.clearScheduledFlush()
    // A transport that is still awaiting its binding reserved no sequence, so it owes nothing.
    if (this.held || this.awaitingBinding || !this.minimumDurationReached()) {
      this.discard()
      await this.settleWithinDeadline([])
      return
    }
    if (options.keepalive === true) {
      await this.flush(options)
      this.closed = true
      this.clearResyncTimer()
      await this.settleWithinDeadline([])
      return
    }
    // Admission runs synchronously, so the caller may stop the recorder right
    // after this call without losing the buffered tail.
    const finalFlush = this.flushInternal()
    this.closed = true
    this.shuttingDown = true
    this.clearResyncTimer()
    this.retryAbort.abort()
    const finalAttempts = this.queue
      .filter((upload) => upload !== this.activeUpload && !this.pagehideUploads.has(upload))
      .map(async (upload) => this.finalAttempt(upload))
    await this.settleWithinDeadline([finalFlush, ...finalAttempts])
  }

  discard(): void {
    this.started = false
    this.closed = true
    this.clearScheduledFlush()
    this.clearResyncTimer()
    this.buffer = []
    this.bufferHasFullSnapshot = false
    this.minimumBufferIncomplete = false
    this.pendingBytes = 0
  }

  getMode(): 'full' | 'buffer' {
    return this.mode
  }

  /**
   * Whether a full recording passed its minimum duration and uploads what it records. A pending
   * binding only defers sequence reservation: the buffered events upload once it is attached.
   */
  isCommitted(): boolean {
    return this.mode === 'full' && this.minimumDurationSatisfied && !this.held && !this.closed
  }

  isHeld(): boolean {
    return this.held
  }

  releaseHeld(takeFullSnapshot: () => void): void {
    if (!this.held) {
      return
    }
    if (this.heldBufferIncomplete || !this.bufferHasFullSnapshot) {
      // rrweb calls the release hook before emitting the interaction. A fresh
      // anchor keeps its node ids valid after background mutations were dropped.
      this.buffer = []
      this.bufferHasFullSnapshot = false
      this.pendingBytes = 0
      takeFullSnapshot()
    }
    this.held = false
    if (this.pendingBytes >= this.config.maxBufferBytes) {
      this.flushAndReport()
    } else {
      this.scheduleFlush()
    }
  }

  private flushAndReport(): void {
    this.flushInternal().catch((error: unknown) => {
      safeReportError(this.config.onError, error)
    })
  }

  private scheduleFlush(): void {
    const now = this.config.now()
    const minimumDelay = Math.max(0, this.config.minSessionDurationMs - (now - this.startedAt))
    const interval = Math.max(resolveFlushInterval(this.config.flushIntervalMs, now - this.lastUserActivityAt), minimumDelay)
    this.scheduleFlushIn(now, interval)
  }

  private scheduleFlushIn(now: number, interval: number): void {
    if (!this.started || this.mode !== 'full' || this.held || this.buffer.length === 0) {
      return
    }
    const flushAt = now + interval
    if (this.timer !== undefined && this.nextFlushAt !== undefined && this.nextFlushAt <= flushAt) {
      return
    }
    this.clearScheduledFlush()
    this.nextFlushAt = flushAt
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextFlushAt = undefined
      this.flushAndReport()
    }, interval)
  }

  private clearScheduledFlush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.nextFlushAt = undefined
  }

  private minimumDurationReached(): boolean {
    if (this.minimumDurationSatisfied || this.config.minSessionDurationMs === 0) {
      return true
    }
    if (this.firstObservedTimestamp === undefined || this.lastObservedTimestamp === undefined) {
      return false
    }
    return this.lastObservedTimestamp - this.firstObservedTimestamp >= this.config.minSessionDurationMs
  }

  private finishMinimumBufferingEvent(): void {
    if (this.minimumDurationReached()) {
      this.flushAndReport()
    } else {
      this.scheduleFlush()
    }
  }

  private refreshMinimumBuffer(): boolean {
    const refreshStartIndex = this.buffer.length
    const refreshStartBytes = this.pendingBytes
    if (this.takeFullSnapshot !== undefined) {
      this.refreshingMinimumSnapshot = true
      try {
        this.takeFullSnapshot()
      } catch (error) {
        safeReportError(this.config.onError, error)
      } finally {
        this.refreshingMinimumSnapshot = false
      }
    }
    if (this.buffer.slice(refreshStartIndex).some((event) => event.type === EventType.FullSnapshot)) {
      this.minimumBufferIncomplete = false
      return true
    }
    this.buffer.length = refreshStartIndex
    this.pendingBytes = refreshStartBytes
    return false
  }

  private snapshotIdentity(): ChunkIdentity {
    const user = this.snapshotUser()
    let distinctId = this.config.distinctId
    if (this.config.getDistinctId !== undefined) {
      try {
        distinctId = this.config.getDistinctId() ?? this.config.distinctId
      } catch (error) {
        safeReportError(this.config.onError, error)
      }
    } else if (user !== undefined) {
      distinctId = user.id
    }
    return { distinctId, user }
  }

  private createEnvelope(events: RrwebEvent[], seq: number, identity: ChunkIdentity): ChunkEnvelope {
    return {
      version: CHUNK_ENVELOPE_VERSION,
      meta: computeChunkMeta(seq, events, identity.distinctId, this.sessionAttributes, identity.user),
      events,
    }
  }

  private snapshotUser(): ReplayUser | undefined {
    if (this.config.getUser === undefined) {
      return undefined
    }
    try {
      return normalizeReplayUser(this.config.getUser())
    } catch (error) {
      safeReportError(this.config.onError, error)
      return undefined
    }
  }

  /** Returns undefined when the shared sequence record cannot confirm the reservation. */
  private allocateSeq(count: number): number | undefined {
    const seq = this.seq
    const record = this.sequenceRecord
    if (record !== undefined) {
      if (this.sequenceRecordFailed) {
        return undefined
      }
      if (!record.write(seq + count)) {
        // Another document could take over this recording from the stale record and reuse the
        // sequence, so nothing more is uploaded under this recording ID.
        this.sequenceRecordFailed = true
        this.discard()
        try {
          record.onFailure()
        } catch (error) {
          safeReportError(this.config.onError, error)
        }
        return undefined
      }
    }
    this.seq += count
    this.saveSeq(this.sessionId, this.seq)
    return seq
  }

  private enqueue(
    events: RrwebEvent[],
    eventBytes: number,
    sessionId: string,
    identity: ChunkIdentity,
    background = false,
    prepared?: LifecycleChunk
  ): QueuedUpload | undefined {
    // Two full batches always fit, so a large maxBufferBytes does not reject
    // the next batch while a healthy upload is still in flight.
    const maxQueuedBytes = Math.max(MAX_QUEUED_BYTES, 2 * this.config.maxBufferBytes)
    if (this.queue.length > 0 && this.retainedBytes + eventBytes > maxQueuedBytes) {
      // The rejected batch gets no seq, so chunks already queued stay valid.
      safeReportError(
        this.config.onError,
        new ReplayUploadError({ cause: new Error('replay upload queue is full'), reason: 'not-sent', seq: undefined, sessionId })
      )
      this.beginResync()
      return undefined
    }
    const seq = this.allocateSeq(1)
    if (seq === undefined) {
      return undefined
    }
    let resolve: () => void = () => undefined
    const done = new Promise<void>((settle) => {
      resolve = settle
    })
    const upload: QueuedUpload = {
      body: undefined,
      done,
      events,
      hasFullSnapshot: events.some((event) => event.type === EventType.FullSnapshot),
      identity,
      reachedFetch: false,
      attempting: false,
      background,
      pagehide: false,
      prepared,
      resolve,
      retainedBytes: eventBytes,
      seq,
      sessionId,
      settled: false,
    }
    this.queue.push(upload)
    this.retainedBytes += eventBytes
    if (!this.draining) {
      this.draining = true
      this.drainPromise = this.drain()
    }
    return upload
  }

  private async drain(): Promise<void> {
    try {
      while (!this.shuttingDown) {
        const upload = this.queue.find((candidate) => !this.pagehideUploads.has(candidate))
        if (upload === undefined) {
          break
        }
        this.activeUpload = upload
        // eslint-disable-next-line no-await-in-loop -- ordinary uploads are delivered in seq order.
        const failure = await this.deliverQueued(upload)
        this.activeUpload = undefined
        this.settle(upload, failure)
      }
    } finally {
      // Cleared synchronously with the loop exit so a concurrent enqueue restarts draining.
      this.activeUpload = undefined
      this.draining = false
    }
  }

  private async deliverQueued(upload: QueuedUpload): Promise<UploadFailure | undefined> {
    const compressionFailure = await this.compressQueued(upload)
    if (compressionFailure !== undefined || upload.settled) {
      return compressionFailure
    }
    const firstAttemptAt = Date.now()
    let previousError: unknown
    for (let attempt = 1; ; attempt++) {
      if (this.pagehideUploads.has(upload)) {
        return upload.done.then(() => undefined)
      }
      // The budget covers each attempt's request time, not only the waits between them.
      const remaining = RETRY_BUDGET_MS - (Date.now() - firstAttemptAt)
      // A background tab can fire the backoff timer after the budget has already run out.
      if (attempt > 1 && remaining <= 0) {
        return toUploadFailure(previousError, upload.reachedFetch)
      }
      // eslint-disable-next-line no-await-in-loop -- retry attempts must be sequential for one chunk.
      const error = await this.attemptQueued(upload, Math.min(REPLAY_UPLOAD_TIMEOUT_MS, remaining))
      if (error === undefined) {
        return undefined
      }
      previousError = error
      const retryDelay = getRetryDelay(error, attempt, this.config.random)
      if (retryDelay === undefined || this.shuttingDown || upload.pagehide || Date.now() - firstAttemptAt + retryDelay >= RETRY_BUDGET_MS) {
        return toUploadFailure(error, upload.reachedFetch)
      }
      // eslint-disable-next-line no-await-in-loop -- backoff must complete before the next retry.
      await this.backoff(retryDelay)
    }
  }

  private retainCompressedBody(upload: QueuedUpload, body: Uint8Array): void {
    this.retainedBytes += body.byteLength - upload.retainedBytes
    upload.retainedBytes = body.byteLength
    upload.body = body
    upload.events = undefined
  }

  private compressQueuedSync(upload: QueuedUpload): UploadFailure | undefined {
    const prepared = upload.prepared
    upload.prepared = undefined
    if (upload.body !== undefined || upload.events === undefined || upload.settled) {
      return undefined
    }
    // A loss handled before this point can trim the events; the body must match them.
    if (prepared?.body !== undefined && prepared.events === upload.events) {
      this.retainCompressedBody(upload, prepared.body)
      return undefined
    }
    try {
      const input = strToU8(JSON.stringify(this.createEnvelope(upload.events, upload.seq, upload.identity)))
      this.retainCompressedBody(upload, this.compression.gzipSync(input))
      return undefined
    } catch (error) {
      return { cause: error, reason: 'not-sent' }
    }
  }

  private async compressQueued(upload: QueuedUpload): Promise<UploadFailure | undefined> {
    if (this.shuttingDown || upload.background) {
      return this.compressQueuedSync(upload)
    }
    if (upload.body !== undefined || upload.events === undefined) {
      return undefined
    }
    const events = upload.events
    try {
      const input = strToU8(JSON.stringify(this.createEnvelope(events, upload.seq, upload.identity)))
      const body = await this.compressOrdinary(input)
      // A loss handled during compression can trim the events; the body must match them.
      if (upload.events !== events) {
        return await this.compressQueued(upload)
      }
      if (!upload.settled) {
        this.retainCompressedBody(upload, body)
      }
      return undefined
    } catch (error) {
      return { cause: error, reason: 'not-sent' }
    }
  }

  private async attemptQueued(upload: QueuedUpload, timeoutMs = REPLAY_UPLOAD_TIMEOUT_MS): Promise<unknown> {
    const body = upload.body
    if (body === undefined) {
      return undefined
    }
    upload.attempting = true
    try {
      await this.send(
        this.prepareUpload(body, upload.seq, upload.sessionId, upload.background),
        () => {
          upload.reachedFetch = true
        },
        timeoutMs
      )
      return undefined
    } catch (error) {
      return error
    } finally {
      upload.attempting = false
    }
  }

  private async finalAttempt(upload: QueuedUpload): Promise<void> {
    const compressionFailure = upload.background ? this.compressQueuedSync(upload) : await this.compressQueued(upload)
    if (compressionFailure !== undefined) {
      this.settle(upload, compressionFailure)
      return
    }
    const error = await this.attemptQueued(upload)
    this.settle(upload, error === undefined ? undefined : toUploadFailure(error, upload.reachedFetch))
  }

  private async trackLifecycle(run: Promise<void>): Promise<void> {
    this.lifecycleFlights.add(run)
    const forget = (): void => {
      this.lifecycleFlights.delete(run)
    }
    run.then(forget, forget)
    return run
  }

  private async settleWithinDeadline(pending: Promise<unknown>[]): Promise<void> {
    const outstanding = Promise.all([...pending, this.drainPromise, ...this.lifecycleFlights]).then(
      () => undefined,
      () => undefined
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REPLAY_UPLOAD_TIMEOUT_MS)
    })
    await Promise.race([outstanding, deadline])
    clearTimeout(timer)
    if (!this.shuttingDown) {
      return
    }
    this.deadlineAbort.abort(new Error('replay upload did not finish before shutdown'))
    for (const upload of [...this.queue]) {
      this.settle(upload, {
        cause: new Error('replay upload did not finish before shutdown'),
        reason: upload.reachedFetch ? 'unconfirmed' : 'not-sent',
      })
    }
  }

  private settle(upload: QueuedUpload, failure: UploadFailure | undefined): void {
    if (upload.settled) {
      return
    }
    upload.settled = true
    this.pagehideUploads.delete(upload)
    this.retainedBytes -= upload.retainedBytes
    const index = this.queue.indexOf(upload)
    if (index >= 0) {
      this.queue.splice(index, 1)
    }
    upload.body = undefined
    upload.events = undefined
    upload.resolve()
    if (failure !== undefined) {
      this.handleSequencedLoss(upload.seq, upload.sessionId, failure)
    }
  }

  private handleSequencedLoss(seq: number, sessionId: string, failure: UploadFailure): void {
    const droppedSeqs: number[] = []
    const permanent = isPermanentRejection(failure)
    if (permanent) {
      this.closeAfterPermanentRejection(droppedSeqs)
    } else if (!this.shuttingDown) {
      let anchored = false
      for (const upload of [...this.queue]) {
        if (upload.seq < seq) {
          continue
        }
        // A compressed body may already be on the wire and cannot be recalled;
        // a snapshot inside it still re-anchors what follows.
        if (upload.events === undefined) {
          if (upload.hasFullSnapshot) {
            anchored = true
            break
          }
          continue
        }
        if (upload.hasFullSnapshot) {
          // Events recorded before the snapshot still depend on the lost chunk.
          const events = eventsFromAnchor(upload.events)
          const eventBytes = sumEventBytes(events)
          this.retainedBytes += eventBytes - upload.retainedBytes
          upload.retainedBytes = eventBytes
          upload.events = events
          anchored = true
          break
        }
        droppedSeqs.push(upload.seq)
        this.settle(upload, undefined)
      }
      if (!anchored && !this.trimBufferToAnchor()) {
        this.beginResync()
      }
    }
    safeReportError(
      this.config.onError,
      new ReplayUploadError({
        cause: failure.cause,
        droppedSeqs,
        reason: failure.reason,
        seq,
        sessionId,
        status: failure.status,
      })
    )
    if (permanent && !this.permanentlyRejected) {
      this.permanentlyRejected = true
      // The loss is detected inside the upload queue's settlement, so the owner stops afterwards.
      queueMicrotask(() => {
        try {
          this.onPermanentRejection?.()
        } catch (error) {
          safeReportError(this.config.onError, error)
        }
      })
    }
  }

  /**
   * Every later chunk would get the same answer, so a resync snapshot would only serialize the DOM
   * for another rejected request.
   */
  private closeAfterPermanentRejection(droppedSeqs: number[]): void {
    this.discard()
    this.retryAbort.abort()
    for (const upload of [...this.queue]) {
      // A request already on the wire cannot be recalled, and settles with its own response.
      if (!upload.attempting) {
        droppedSeqs.push(upload.seq)
        this.settle(upload, undefined)
      }
    }
  }

  private trimBufferToAnchor(): boolean {
    if (!this.buffer.some((event) => event.type === EventType.FullSnapshot)) {
      return false
    }
    this.buffer = eventsFromAnchor(this.buffer)
    this.pendingBytes = sumEventBytes(this.buffer)
    return true
  }

  private beginResync(): void {
    if (this.closed) {
      return
    }
    this.resyncPending = true
    this.buffer = []
    this.bufferHasFullSnapshot = false
    this.pendingBytes = 0
    this.clearScheduledFlush()
    this.scheduleResyncSnapshot()
  }

  private scheduleResyncSnapshot(): void {
    if (this.resyncTimer !== undefined || this.closed) {
      return
    }
    const wait = this.lastResyncAt === undefined ? 0 : Math.max(0, this.lastResyncAt + RESYNC_MIN_INTERVAL_MS - this.config.now())
    // A timer also moves rrweb's synchronous snapshot emission out of the
    // transport call stack that detected the loss.
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined
      this.takeResyncSnapshot()
    }, wait)
  }

  private takeResyncSnapshot(): void {
    if (!this.resyncPending || this.closed || this.takeFullSnapshot === undefined) {
      return
    }
    this.lastResyncAt = this.config.now()
    try {
      this.takeFullSnapshot()
    } catch (error) {
      safeReportError(this.config.onError, error)
      this.scheduleResyncSnapshot()
      return
    }
    if (this.isResyncPending()) {
      safeReportError(this.config.onError, new Error('replay resync snapshot produced no full snapshot'))
      this.scheduleResyncSnapshot()
    }
  }

  // Read through a method: takeFullSnapshot() re-enters add(), which clears the
  // flag in a way TypeScript's narrowing cannot see.
  private isResyncPending(): boolean {
    return this.resyncPending
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== undefined) {
      clearTimeout(this.resyncTimer)
      this.resyncTimer = undefined
    }
  }

  private async backoff(milliseconds: number): Promise<void> {
    const signal = this.retryAbort.signal
    if (signal.aborted) {
      return
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        if (this.wakeRetry === finish) {
          this.wakeRetry = undefined
        }
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      signal.addEventListener('abort', finish)
      this.wakeRetry = finish
    })
  }

  private prepareUpload(body: Uint8Array, seq: number, sessionId: string, keepalive: boolean): PreparedUpload {
    const reservedBytes = keepalive && this.reservedKeepaliveBytes + body.byteLength <= MAX_KEEPALIVE_RESERVED_BYTES ? body.byteLength : 0
    this.reservedKeepaliveBytes += reservedBytes
    return { body, seq, sessionId, reservedBytes, requestKeepalive: reservedBytes > 0 }
  }

  /**
   * Packs event prefixes into chunks whose compressed envelopes fit the keepalive limit, using
   * the sequences this transport allocates next. With a shared budget (pagehide), the events
   * left once it is spent stay as one unsplit chunk: they use an ordinary request either way,
   * so smaller pieces would only add requests and synchronous compression.
   */
  private splitKeepaliveEventChunks(
    events: RrwebEvent[],
    identity: ChunkIdentity,
    sharedBudget = Number.POSITIVE_INFINITY
  ): LifecycleChunk[] {
    const sizes = events.map(estimateBytes)
    const chunks: LifecycleChunk[] = []
    let remaining = sharedBudget
    let ratio: number | undefined
    let start = 0
    while (start < events.length) {
      const limit = Math.min(MAX_KEEPALIVE_RESERVED_BYTES, remaining)
      if (limit < MIN_KEEPALIVE_CHUNK_BYTES) {
        chunks.push({ events: events.slice(start), eventBytes: sumSizes(sizes, start, events.length) })
        break
      }
      const seq = this.seq + chunks.length
      // Bound synchronous compression work: the first candidate is capped by raw size, later
      // ones are sized from the compression ratio already observed.
      const firstTarget =
        ratio === undefined ? MAX_KEEPALIVE_RAW_BYTES : Math.min(MAX_KEEPALIVE_RAW_BYTES, limit * ratio * KEEPALIVE_PACKING_HEADROOM)
      let end = prefixEnd(sizes, start, firstTarget)
      for (;;) {
        const batch = events.slice(start, end)
        const eventBytes = sumSizes(sizes, start, end)
        let body: Uint8Array
        try {
          body = this.compression.gzipSync(strToU8(JSON.stringify(this.createEnvelope(batch, seq, identity))))
        } catch {
          // Reserve this sequence and report its failure through the normal loss /
          // resync path, just as for an ordinary compression failure. Later pagehide
          // chunks cannot use keepalive ahead of it.
          chunks.push({ events: batch, eventBytes })
          remaining = Number.isFinite(sharedBudget) ? 0 : remaining
          break
        }
        ratio = eventBytes / Math.max(1, body.byteLength)
        if (body.byteLength <= limit) {
          chunks.push({ events: batch, eventBytes, body })
          remaining -= body.byteLength
          break
        }
        if (end - start === 1) {
          if (Number.isFinite(sharedBudget)) {
            // Keepalive cannot carry this event now, so it leads the unsplit tail.
            chunks.push({ events: events.slice(start), eventBytes: sumSizes(sizes, start, events.length) })
            end = events.length
          } else {
            // An indivisible oversized event is sent using ordinary fetch.
            chunks.push({ events: batch, eventBytes, body })
          }
          break
        }
        end = Math.max(start + 1, Math.min(end - 1, prefixEnd(sizes, start, limit * ratio * KEEPALIVE_PACKING_HEADROOM)))
      }
      start = end
    }
    return chunks
  }

  private async deliverLifecycle(eventChunks: LifecycleChunk[], seq: number, sessionId: string, identity: ChunkIdentity): Promise<void> {
    const prepared: (PreparedUpload | undefined)[] = []
    for (let index = 0; index < eventChunks.length; index++) {
      const chunk = eventChunks[index]
      if (chunk === undefined) {
        prepared.push(undefined)
        continue
      }
      try {
        prepared.push({
          body: chunk.body ?? this.compression.gzipSync(strToU8(JSON.stringify(this.createEnvelope(chunk.events, seq + index, identity)))),
          requestKeepalive: false,
          reservedBytes: 0,
          seq: seq + index,
          sessionId,
        })
      } catch (error) {
        this.handleSequencedLoss(seq + index, sessionId, { cause: error, reason: 'not-sent' })
        prepared.push(undefined)
      }
    }

    let admitKeepalive = true
    let availableBytes = Math.max(0, MAX_KEEPALIVE_RESERVED_BYTES - this.reservedKeepaliveBytes)
    for (const upload of prepared) {
      if (upload === undefined) {
        admitKeepalive = false
        continue
      }
      if (admitKeepalive && upload.body.byteLength <= availableBytes) {
        upload.requestKeepalive = true
        upload.reservedBytes = upload.body.byteLength
        this.reservedKeepaliveBytes += upload.reservedBytes
        availableBytes -= upload.reservedBytes
      } else {
        admitKeepalive = false
      }
    }

    await Promise.all(
      prepared.map(async (upload) => {
        if (upload === undefined) {
          return
        }
        let reachedFetch = false
        try {
          // Lifecycle uploads get one attempt: the page may be frozen before a retry.
          await this.send(upload, () => {
            reachedFetch = true
          })
        } catch (error) {
          this.handleSequencedLoss(upload.seq, upload.sessionId, toUploadFailure(error, reachedFetch))
        }
      })
    )
  }

  private async compressOrdinary(input: Uint8Array): Promise<Uint8Array> {
    if (!this.asyncCompressionAvailable) {
      return this.compression.gzipSync(input)
    }
    try {
      return await gzipAsync(this.compression, input)
    } catch {
      this.asyncCompressionAvailable = false
      return this.compression.gzipSync(input)
    }
  }

  private async send(upload: PreparedUpload, onRequestStarted: () => void, timeoutMs = REPLAY_UPLOAD_TIMEOUT_MS): Promise<void> {
    let requestStarted: boolean | undefined
    let responseReceived: boolean | undefined
    let responseComplete: boolean | undefined
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`replay upload timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const deadline = this.deadlineAbort.signal
    const onDeadline = (): void => {
      controller.abort(deadline.reason)
    }
    deadline.addEventListener('abort', onDeadline)
    try {
      const url = `${this.config.replayUrl.replace(/\/+$/u, '')}/${encodeURIComponent(upload.sessionId)}?seq=${String(upload.seq)}`
      // A stalled header or token callback would otherwise hold the queue head forever.
      const headers = await raceAbort(this.getUploadHeaders(), controller.signal)
      onRequestStarted()
      const responsePromise = this.config.fetchImpl(url, {
        method: 'POST',
        headers,
        body: upload.body.slice(),
        keepalive: upload.requestKeepalive,
        signal: controller.signal,
      })
      requestStarted = true
      const response = await responsePromise
      responseReceived = true
      responseComplete = await confirmResponseEnd(response)

      if (!response.ok) {
        const retryAfter =
          response.status === 429 || response.status === 503 ? parseRetryAfter(response.headers.get('retry-after'), Date.now()) : undefined
        throw new ReplayIngestError(response.status, retryAfter)
      }
    } finally {
      clearTimeout(timeout)
      deadline.removeEventListener('abort', onDeadline)
      if (upload.reservedBytes > 0 && (requestStarted !== true || responseReceived !== true || responseComplete === true)) {
        this.reservedKeepaliveBytes = Math.max(0, this.reservedKeepaliveBytes - upload.reservedBytes)
      }
    }
  }

  private async getUploadHeaders(): Promise<Record<string, string>> {
    const headers = this.config.headers === undefined ? {} : await this.config.headers()
    const token = await resolveToken(this.config.token)
    const tokenHeaders =
      token === undefined || token.length === 0
        ? headers
        : {
            ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')),
            Authorization: `Bearer ${token}`,
          }
    return {
      ...tokenHeaders,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    }
  }

  canResumeSequence(): boolean {
    if (this.awaitingBinding) {
      // This document never reserved a sequence, so the stored one is still the latest.
      return true
    }
    // A failed write leaves the previous value in storage. Do not hand that
    // stale sequence to a new document, even if setItem silently discarded it.
    return this.readPersistedSequence() === this.seq
  }

  isAwaitingBinding(): boolean {
    return this.awaitingBinding
  }

  /** Attach the recording's shared sequence record and start sending the buffered events. */
  bind(binding: SequenceRecordBinding): void {
    if (!this.awaitingBinding || this.closed) {
      return
    }
    this.sequenceRecord = binding
    this.seq = binding.initialSeq
    this.awaitingBinding = false
    if (this.bindingBufferIncomplete) {
      // Events were dropped to keep the pending buffer bounded. A fresh anchor keeps node ids valid.
      this.bindingBufferIncomplete = false
      this.buffer = []
      this.bufferHasFullSnapshot = false
      this.pendingBytes = 0
      this.takeFullSnapshot?.()
    }
    if (this.mode !== 'full' || this.held || this.buffer.length === 0) {
      return
    }
    if (this.pendingBytes >= this.config.maxBufferBytes) {
      this.flushAndReport()
    } else {
      this.scheduleFlush()
    }
  }

  private readPersistedSequence(): number | undefined {
    if (this.storage === null) {
      return undefined
    }
    try {
      const raw = this.storage.getItem(SEQ_STORAGE_KEY)
      if (raw === null) {
        return undefined
      }
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) {
        return undefined
      }
      const value = parsed as { id?: unknown; seq?: unknown }
      return value.id === this.sessionId && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0
        ? value.seq
        : undefined
    } catch {
      return undefined
    }
  }

  private saveSeq(sessionId: string, seq: number): void {
    if (this.storage === null) {
      return
    }
    try {
      this.storage.setItem(SEQ_STORAGE_KEY, JSON.stringify({ id: sessionId, seq }))
    } catch {
      // Cross-page sequence resume is best-effort.
    }
  }
}

function safeReportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    const result = onError?.(error)
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch(() => undefined)
    }
  } catch {
    // Transport failures and error reporters must not escape into the host app.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

class ReplayIngestError extends Error {
  readonly retryAfter: number | undefined
  readonly status: number

  constructor(status: number, retryAfter?: number) {
    super(`replay ingest failed: ${String(status)}`)
    this.status = status
    this.retryAfter = retryAfter
    this.name = 'ReplayIngestError'
  }
}

async function resolveToken(token: ResolvedSessionReplayConfig['token']): Promise<string | undefined> {
  if (typeof token === 'function') {
    return token()
  }
  return token
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function estimateBytes(event: RrwebEvent): number {
  try {
    return strToU8(JSON.stringify(event)).byteLength
  } catch {
    return 0
  }
}

/** Drops the events before the first FullSnapshot, keeping its preceding Meta event. */
function eventsFromAnchor(events: RrwebEvent[]): RrwebEvent[] {
  const snapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot)
  if (snapshotIndex < 0) {
    return events
  }
  const start = snapshotIndex > 0 && events[snapshotIndex - 1]?.type === EventType.Meta ? snapshotIndex - 1 : snapshotIndex
  return events.slice(start)
}

function sumEventBytes(events: RrwebEvent[]): number {
  return events.reduce((total, event) => total + estimateBytes(event), 0)
}

function sumSizes(sizes: number[], start: number, end: number): number {
  let total = 0
  for (let index = start; index < end; index++) {
    total += sizes[index] ?? 0
  }
  return total
}

/** Returns the end of the longest prefix from `start` within `maxBytes`, always taking at least one event. */
function prefixEnd(sizes: number[], start: number, maxBytes: number): number {
  let end = start + 1
  let total = sizes[start] ?? 0
  while (end < sizes.length && total + (sizes[end] ?? 0) <= maxBytes) {
    total += sizes[end] ?? 0
    end++
  }
  return end
}

async function gzipAsync(compression: Compression, input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const targets: EventTarget[] = []
    if (typeof window !== 'undefined') {
      targets.push(window)
    }
    if (typeof document !== 'undefined') {
      targets.push(document)
    }
    const removePolicyListeners = (): void => {
      for (const target of targets) {
        target.removeEventListener('securitypolicyviolation', onPolicyViolation)
      }
    }
    const finish = (error: Error | null, data?: Uint8Array): void => {
      removePolicyListeners()
      if (error !== null) {
        reject(error)
        return
      }
      resolve(data as Uint8Array)
    }
    const onPolicyViolation = (event: Event): void => {
      const violation = event as SecurityPolicyViolationEvent
      if (violation.effectiveDirective.includes('worker-src') || violation.violatedDirective.includes('worker-src')) {
        finish(new Error('replay compression worker blocked by Content Security Policy'))
      }
    }
    for (const target of targets) {
      target.addEventListener('securitypolicyviolation', onPolicyViolation)
    }
    try {
      compression.gzip(input, { level: 6 }, (error, data) => {
        finish(error, data)
      })
    } catch (error) {
      removePolicyListeners()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function confirmResponseEnd(response: Response): Promise<boolean> {
  if (response.body === null) {
    return true
  }
  try {
    await response.body.cancel()
    return true
  } catch {
    return false
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** Returns undefined for a terminal failure. */
function getRetryDelay(error: unknown, attempt: number, random: () => number): number | undefined {
  if (error instanceof ReplayIngestError) {
    if (!isRetryableStatus(error.status)) {
      return undefined
    }
  }
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
  // Jitter spreads retries from many browsers recovering from the same outage.
  const backoff = Math.round(exponential * (1 - 0.5 * random()))
  // Retry-After can only lengthen the wait: `0` or a past date (clock skew)
  // would otherwise retry a rate-limited endpoint without pause.
  const retryAfter = error instanceof ReplayIngestError ? error.retryAfter : undefined
  return retryAfter === undefined ? backoff : Math.max(retryAfter, backoff)
}

// These answer one chunk, or clear without a configuration change.
const CHUNK_SCOPED_CLIENT_STATUSES = new Set([408, 413, 425, 429])

/** A 4xx such as a revoked token, a deleted application, or a usage block, which later chunks also get. */
function isPermanentRejection(failure: UploadFailure): boolean {
  const status = failure.status
  return failure.reason === 'rejected' && status !== undefined && status >= 400 && status < 500 && !CHUNK_SCOPED_CLIENT_STATUSES.has(status)
}

function toUploadFailure(error: unknown, reachedFetch: boolean): UploadFailure {
  const status = error instanceof ReplayIngestError ? error.status : undefined
  if (status !== undefined && !isRetryableStatus(status)) {
    return { cause: error, reason: 'rejected', status }
  }
  return { cause: error, reason: reachedFetch ? 'unconfirmed' : 'not-sent', status }
}

/** Returns the requested delay in milliseconds, or undefined when the header is absent or invalid. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined
  }
  const normalized = value.trim()
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized)
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined
  }

  const timestamp = parseHttpDate(normalized, now)
  return timestamp === undefined ? undefined : Math.max(0, timestamp - now)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

function parseHttpDate(value: string, now: number): number | undefined {
  const imf =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(
      value
    )
  if (imf !== null) {
    return checkedTimestamp(imf[1], imf[2], imf[3], imf[4], imf[5], imf[6], imf[7])
  }

  const rfc850 =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(
      value
    )
  if (rfc850 !== null) {
    const currentYear = new Date(now).getUTCFullYear()
    const shortYear = Number(rfc850[4])
    let year = Math.floor(currentYear / 100) * 100 + shortYear
    if (year > currentYear + 50) {
      year -= 100
    }
    return checkedTimestamp(rfc850[1], rfc850[2], rfc850[3], String(year), rfc850[5], rfc850[6], rfc850[7])
  }

  const asctime =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(
      value
    )
  if (asctime !== null) {
    return checkedTimestamp(asctime[1], asctime[3]?.trim(), asctime[2], asctime[7], asctime[4], asctime[5], asctime[6])
  }
  return undefined
}

function checkedTimestamp(
  weekday: string | undefined,
  dayText: string | undefined,
  monthText: string | undefined,
  yearText: string | undefined,
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined
): number | undefined {
  const day = Number(dayText)
  const month = MONTHS.indexOf(monthText as (typeof MONTHS)[number])
  const year = Number(yearText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, second, 0)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined
  }
  const weekdayIndex = SHORT_WEEKDAYS.indexOf(weekday as (typeof SHORT_WEEKDAYS)[number])
  const longWeekdayIndex = LONG_WEEKDAYS.indexOf(weekday as (typeof LONG_WEEKDAYS)[number])
  const expectedWeekday = weekdayIndex >= 0 ? weekdayIndex : longWeekdayIndex
  return expectedWeekday === date.getUTCDay() ? date.getTime() : undefined
}
