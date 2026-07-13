import { gzip, gzipSync, strToU8 } from 'fflate'

import { computeChunkMeta } from './extract'
import { safeSessionStorage } from './session'
import { CHUNK_ENVELOPE_VERSION, EventType } from './types'
import type { ChunkEnvelope, ResolvedSessionReplayConfig, RrwebEvent } from './types'

export const SEQ_STORAGE_KEY = 'lf_session_replay_seq'

const MAX_SEND_ATTEMPTS = 3
const SEND_BACKOFF_MS = 500
const MAX_RETRY_AFTER_MS = 10_000
const MAX_KEEPALIVE_RESERVED_BYTES = 48_000
const MAX_KEEPALIVE_CHUNK_BYTES = 48_000

interface Compression {
  gzip: typeof gzip
  gzipSync: typeof gzipSync
}

interface PreparedUpload {
  body: Uint8Array
  lifecycle: boolean
  requestKeepalive: boolean
  reservedBytes: number
  seq: number
  sessionId: string
}

type RetryAfter = { kind: 'delay'; milliseconds: number } | { kind: 'fallback' } | { kind: 'too-long' }

const DEFAULT_COMPRESSION: Compression = { gzip, gzipSync }

export class ReplayTransport {
  private buffer: RrwebEvent[] = []
  private pendingBytes = 0
  private seq = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private mode: 'full' | 'buffer'
  private flushing: Promise<void> | undefined
  private reservedKeepaliveBytes = 0
  private asyncCompressionAvailable = true
  private readonly config: ResolvedSessionReplayConfig
  private readonly compression: Compression
  private readonly storage: Storage | null
  private sessionId: string

  constructor(
    config: ResolvedSessionReplayConfig,
    sessionId: string,
    mode: 'full' | 'buffer',
    storage: Storage | null = safeSessionStorage(),
    compression: Compression = DEFAULT_COMPRESSION
  ) {
    this.config = config
    this.sessionId = sessionId
    this.mode = mode
    this.storage = storage
    this.compression = compression
    this.seq = this.loadSeq(sessionId)
  }

  start(): void {
    if (this.timer !== undefined || this.mode !== 'full') {
      return
    }
    this.timer = setInterval(() => {
      this.flushAndReport()
    }, this.config.flushIntervalMs)
  }

  add(event: RrwebEvent): void {
    const eventBytes = estimateBytes(event)
    if (this.mode === 'buffer') {
      if (event.type === EventType.FullSnapshot) {
        this.buffer = [event]
        this.pendingBytes = eventBytes
        return
      }
      // Incremental rrweb events are only useful after a full-snapshot anchor.
      // Keep the earliest contiguous prefix so later events never depend on a
      // state transition that was trimmed from the buffer.
      if (this.buffer.length === 0 || eventBytes > this.config.maxBufferBytes) {
        return
      }
      if (this.pendingBytes + eventBytes > this.config.maxBufferBytes) {
        return
      }
    }

    this.buffer.push(event)
    this.pendingBytes += eventBytes

    if (this.mode === 'full' && this.pendingBytes >= this.config.maxBufferBytes) {
      this.flushAndReport()
    }
  }

  async triggerFlush(): Promise<void> {
    if (this.mode === 'buffer') {
      this.mode = 'full'
      this.start()
    }
    return this.flush()
  }

  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.mode === 'buffer' || this.buffer.length === 0) {
      return
    }

    const events = this.buffer
    this.buffer = []
    this.pendingBytes = 0
    const eventChunks = options.keepalive === true ? splitKeepaliveEventChunks(events) : [events]
    const seq = this.seq
    this.seq += eventChunks.length
    const sessionId = this.sessionId
    this.saveSeq(sessionId, this.seq)

    // A pagehide/visibility keepalive must start before the browser freezes the
    // page, even when an ordinary upload is still awaiting its response.
    const prior = options.keepalive === true ? Promise.resolve() : (this.flushing ?? Promise.resolve())
    const run =
      options.keepalive === true
        ? this.deliverLifecycle(eventChunks, seq, sessionId)
        : prior.then(async () => {
            for (let index = 0; index < eventChunks.length; index++) {
              const eventChunk = eventChunks[index]
              if (eventChunk === undefined) {
                continue
              }
              // eslint-disable-next-line no-await-in-loop -- ordinary flushes preserve response order.
              await this.deliverOrdinary(eventChunk, seq + index, sessionId)
            }
          })
    const previouslyTracked = this.flushing
    this.flushing =
      options.keepalive === true && previouslyTracked !== undefined
        ? Promise.all([previouslyTracked, run]).then(
            () => undefined,
            () => undefined
          )
        : run.catch(() => undefined)
    await run
  }

  rotate(newSessionId: string): boolean {
    if (newSessionId === this.sessionId) {
      return false
    }

    if (this.mode === 'buffer') {
      this.buffer = []
      this.pendingBytes = 0
    } else {
      this.flushAndReport()
    }

    this.sessionId = newSessionId
    this.seq = this.loadSeq(newSessionId)
    return true
  }

  async shutdown(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.flush(options)
    await this.flushing
  }

  discard(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.buffer = []
    this.pendingBytes = 0
  }

  getMode(): 'full' | 'buffer' {
    return this.mode
  }

  private flushAndReport(): void {
    this.flush().catch((error: unknown) => {
      safeReportError(this.config.onError, error)
    })
  }

  private createEnvelope(events: RrwebEvent[], seq: number): ChunkEnvelope {
    let distinctId = this.config.distinctId
    if (this.config.getDistinctId !== undefined) {
      try {
        distinctId = this.config.getDistinctId() ?? this.config.distinctId
      } catch (error) {
        safeReportError(this.config.onError, error)
      }
    }
    return {
      version: CHUNK_ENVELOPE_VERSION,
      meta: computeChunkMeta(seq, events, distinctId),
      events,
    }
  }

  private async deliverOrdinary(events: RrwebEvent[], seq: number, sessionId: string): Promise<void> {
    const envelope = this.createEnvelope(events, seq)

    try {
      const input = strToU8(JSON.stringify(envelope))
      const body = await this.compressOrdinary(input)
      await this.sendWithRetry({ body, lifecycle: false, requestKeepalive: false, reservedBytes: 0, seq, sessionId })
    } catch (error) {
      safeReportError(this.config.onError, error)
    }
  }

  private async deliverLifecycle(eventChunks: RrwebEvent[][], seq: number, sessionId: string): Promise<void> {
    const prepared: (PreparedUpload | undefined)[] = []
    for (let index = 0; index < eventChunks.length; index++) {
      const events = eventChunks[index]
      if (events === undefined) {
        prepared.push(undefined)
        continue
      }
      const envelope = this.createEnvelope(events, seq + index)
      try {
        prepared.push({
          body: this.compression.gzipSync(strToU8(JSON.stringify(envelope))),
          lifecycle: true,
          requestKeepalive: false,
          reservedBytes: 0,
          seq: seq + index,
          sessionId,
        })
      } catch (error) {
        safeReportError(this.config.onError, error)
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
        try {
          await this.sendWithRetry(upload)
        } catch (error) {
          safeReportError(this.config.onError, error)
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

  private async sendWithRetry(upload: PreparedUpload): Promise<void> {
    const maxAttempts = upload.lifecycle ? 1 : MAX_SEND_ATTEMPTS
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- retry attempts must be sequential for one chunk.
        await this.send(upload)
        return
      } catch (error) {
        const retryDelay = getRetryDelay(error, attempt)
        if (retryDelay === undefined || attempt >= maxAttempts) {
          throw error
        }
        // eslint-disable-next-line no-await-in-loop -- backoff must complete before the next retry.
        await delay(retryDelay)
      }
    }
  }

  private async send(upload: PreparedUpload): Promise<void> {
    let requestStarted: boolean | undefined
    let responseReceived: boolean | undefined
    let responseComplete: boolean | undefined
    try {
      const url = `${this.config.replayUrl.replace(/\/+$/u, '')}/${encodeURIComponent(upload.sessionId)}?seq=${String(upload.seq)}`
      const headers = await this.getUploadHeaders()
      const responsePromise = this.config.fetchImpl(url, {
        method: 'POST',
        headers,
        body: upload.body.slice(),
        keepalive: upload.requestKeepalive,
      })
      requestStarted = true
      const response = await responsePromise
      responseReceived = true
      responseComplete = await confirmResponseEnd(response)

      if (!response.ok) {
        const retryAfter = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after'), Date.now()) : undefined
        throw new ReplayIngestError(response.status, retryAfter)
      }
    } finally {
      if (upload.reservedBytes > 0 && (requestStarted !== true || responseReceived !== true || responseComplete === true)) {
        this.reservedKeepaliveBytes = Math.max(0, this.reservedKeepaliveBytes - upload.reservedBytes)
      }
    }
  }

  private async getUploadHeaders(): Promise<Record<string, string>> {
    const headers = this.config.headers === undefined ? {} : await this.config.headers()
    const token = await resolveToken(this.config.token)
    return {
      ...headers,
      ...(token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    }
  }

  private loadSeq(sessionId: string): number {
    if (this.storage === null) {
      return 0
    }
    try {
      const raw = this.storage.getItem(SEQ_STORAGE_KEY)
      if (raw === null) {
        return 0
      }
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) {
        return 0
      }
      const value = parsed as { id?: unknown; seq?: unknown }
      return value.id === sessionId && typeof value.seq === 'number' && Number.isFinite(value.seq) ? value.seq : 0
    } catch {
      return 0
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
  readonly retryAfter: RetryAfter | undefined
  readonly status: number

  constructor(status: number, retryAfter?: RetryAfter) {
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

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function estimateBytes(event: RrwebEvent): number {
  try {
    return strToU8(JSON.stringify(event)).byteLength
  } catch {
    return 0
  }
}

function splitKeepaliveEventChunks(events: RrwebEvent[]): RrwebEvent[][] {
  const chunks: RrwebEvent[][] = []
  let chunk: RrwebEvent[] = []
  let chunkBytes = 0

  for (const event of events) {
    const eventBytes = estimateBytes(event)
    if (chunk.length > 0 && chunkBytes + eventBytes > MAX_KEEPALIVE_CHUNK_BYTES) {
      chunks.push(chunk)
      chunk = []
      chunkBytes = 0
    }
    chunk.push(event)
    chunkBytes += eventBytes
  }

  if (chunk.length > 0) {
    chunks.push(chunk)
  }

  return chunks
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

function getRetryDelay(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof ReplayIngestError)) {
    return SEND_BACKOFF_MS * attempt
  }
  if (error.status === 429) {
    if (error.retryAfter?.kind === 'too-long') {
      return undefined
    }
    return error.retryAfter?.kind === 'delay' ? error.retryAfter.milliseconds : SEND_BACKOFF_MS * attempt
  }
  return error.status < 500 ? undefined : SEND_BACKOFF_MS * attempt
}

function parseRetryAfter(value: string | null, now: number): RetryAfter {
  if (value === null) {
    return { kind: 'fallback' }
  }
  const normalized = value.trim()
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized)
    if (!Number.isSafeInteger(seconds)) {
      return { kind: 'fallback' }
    }
    return classifyRetryDelay(seconds * 1_000)
  }

  const timestamp = parseHttpDate(normalized, now)
  if (timestamp === undefined) {
    return { kind: 'fallback' }
  }
  return classifyRetryDelay(Math.max(0, timestamp - now))
}

function classifyRetryDelay(milliseconds: number): RetryAfter {
  return milliseconds > MAX_RETRY_AFTER_MS ? { kind: 'too-long' } : { kind: 'delay', milliseconds }
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
