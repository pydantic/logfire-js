import { gzip, gzipSync, strToU8 } from 'fflate'

import { computeChunkMeta } from './extract'
import { safeSessionStorage } from './session'
import { CHUNK_ENVELOPE_VERSION, EventType } from './types'
import type { ChunkEnvelope, ResolvedSessionReplayConfig, RrwebEvent } from './types'

export const SEQ_STORAGE_KEY = 'lf_session_replay_seq'

const MAX_SEND_ATTEMPTS = 3
const SEND_BACKOFF_MS = 500
const MAX_KEEPALIVE_BODY_BYTES = 60_000
const MAX_KEEPALIVE_CHUNK_BYTES = 48_000

export class ReplayTransport {
  private buffer: RrwebEvent[] = []
  private pendingBytes = 0
  private seq = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private mode: 'full' | 'buffer'
  private flushing: Promise<void> | undefined
  private readonly config: ResolvedSessionReplayConfig
  private readonly storage: Storage | null
  private sessionId: string

  constructor(
    config: ResolvedSessionReplayConfig,
    sessionId: string,
    mode: 'full' | 'buffer',
    storage: Storage | null = safeSessionStorage()
  ) {
    this.config = config
    this.sessionId = sessionId
    this.mode = mode
    this.storage = storage
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
    if (this.mode === 'buffer' && event.type === EventType.FullSnapshot) {
      this.buffer = []
      this.pendingBytes = 0
    }

    this.buffer.push(event)
    this.pendingBytes += estimateBytes(event)

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
    const run = prior.then(async () => {
      for (let index = 0; index < eventChunks.length; index++) {
        const eventChunk = eventChunks[index]
        if (eventChunk === undefined) {
          continue
        }
        // eslint-disable-next-line no-await-in-loop -- chunks must preserve replay sequence order.
        await this.deliver(eventChunk, seq + index, sessionId, options.keepalive ?? false)
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

  private async deliver(events: RrwebEvent[], seq: number, sessionId: string, keepalive: boolean): Promise<void> {
    const distinctId = this.config.getDistinctId?.() ?? this.config.distinctId
    const envelope: ChunkEnvelope = {
      version: CHUNK_ENVELOPE_VERSION,
      meta: computeChunkMeta(seq, events, distinctId),
      events,
    }

    try {
      const json = JSON.stringify(envelope)
      const body = keepalive ? gzipSync(strToU8(json)) : await gzipAsync(json)
      const useKeepalive = keepalive && body.byteLength <= MAX_KEEPALIVE_BODY_BYTES
      await this.sendWithRetry(sessionId, seq, body, useKeepalive)
    } catch (error) {
      safeReportError(this.config.onError, error)
    }
  }

  private async sendWithRetry(sessionId: string, seq: number, body: Uint8Array, keepalive: boolean): Promise<void> {
    const maxAttempts = keepalive ? 1 : MAX_SEND_ATTEMPTS
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- retry attempts must be sequential for one chunk.
        await this.send(sessionId, seq, body, keepalive)
        return
      } catch (error) {
        const nonRetryable = error instanceof ReplayIngestError && error.status < 500
        if (nonRetryable || attempt >= maxAttempts) {
          throw error
        }
        // eslint-disable-next-line no-await-in-loop -- backoff must complete before the next retry.
        await delay(SEND_BACKOFF_MS * attempt)
      }
    }
  }

  private async send(sessionId: string, seq: number, body: Uint8Array, keepalive: boolean): Promise<void> {
    const url = `${this.config.replayUrl.replace(/\/+$/u, '')}/${encodeURIComponent(sessionId)}?seq=${String(seq)}`
    const headers = await this.getUploadHeaders()
    const response = await this.config.fetchImpl(url, {
      method: 'POST',
      headers,
      body: body.slice(),
      keepalive,
    })

    if (!response.ok) {
      throw new ReplayIngestError(response.status)
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
    onError?.(error)
  } catch {
    // Transport failures and error reporters must not escape into the host app.
  }
}

class ReplayIngestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`replay ingest failed: ${String(status)}`)
    this.status = status
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
    return JSON.stringify(event).length
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

async function gzipAsync(json: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gzip(strToU8(json), { level: 6 }, (error, data) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(data)
    })
  })
}
