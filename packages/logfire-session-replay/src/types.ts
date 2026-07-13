export interface RrwebEvent {
  type: number
  data: unknown
  timestamp: number
}

export const EventType = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6,
} as const

export const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
} as const

export const MouseInteractions = {
  MouseUp: 0,
  MouseDown: 1,
  Click: 2,
  ContextMenu: 3,
  DblClick: 4,
} as const

export const CustomTag = {
  Error: 'logfire.error',
  Trace: 'logfire.trace',
  Console: 'logfire.console',
  Network: 'logfire.network',
  Navigation: 'logfire.navigation',
} as const

export const CHUNK_ENVELOPE_VERSION = 1 as const

export type MaybePromise<T> = T | Promise<T>
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
export type SamplingMode = 'full' | 'buffer' | 'off'

export interface ConsolePayload {
  level: ConsoleLevel
  args: string[]
  source?: string
}

export interface NetworkPayload {
  method: string
  url: string
  status: number
  durationMs: number
  failed?: boolean
  reqBytes?: number
  resBytes?: number
}

export interface NavigationPayload {
  url: string
  kind: 'load' | 'push' | 'replace' | 'pop'
}

export interface ChunkMeta {
  seq: number
  firstTimestamp: number
  lastTimestamp: number
  eventCount: number
  clickCount: number
  keypressCount: number
  errorCount: number
  hasFullSnapshot: boolean
  urls: string[]
  traceIds: string[]
  distinctId?: string
}

export interface ChunkEnvelope {
  version: typeof CHUNK_ENVELOPE_VERSION
  meta: ChunkMeta
  events: RrwebEvent[]
}

/**
 * Experimental session replay recorder configuration.
 *
 * Logfire Platform replay ingest and playback are still feature-flagged, so
 * keep browser replay rollout behind an application flag.
 */
export interface SessionReplayConfig {
  /**
   * Replay upload endpoint. For normal browser applications this should be a
   * backend proxy endpoint. With the direct-token escape hatch, this may point
   * at Logfire ingest. The SDK posts to `${replayUrl}/${sessionId}?seq=${seq}`.
   */
  replayUrl: string
  /**
   * Headers added to each replay upload. Use this for CSRF/session auth to the
   * caller's backend proxy.
   */
  headers?: () => MaybePromise<Record<string, string>>
  /**
   * Advanced escape hatch for direct Logfire ingest. Prefer `headers` with a
   * backend proxy for normal browser applications. When provided, the SDK adds
   * `Authorization: Bearer ${token}` to replay uploads.
   */
  token?: string | (() => MaybePromise<string>)
  /**
   * Optional external session id source. The browser SDK integration should
   * pass its RUM session id here.
   */
  getSessionId?: () => string | undefined

  /** Probability of recording each new browser session in full. */
  sessionSampleRate?: number
  /** Probability of buffering each otherwise-unsampled session for uncaught error promotion. */
  onErrorSampleRate?: number

  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string

  flushIntervalMs?: number
  maxBufferBytes?: number

  sessionIdleTimeoutMs?: number
  maxSessionDurationMs?: number

  distinctId?: string
  getDistinctId?: () => string | undefined
  getTraceContext?: () => { traceId?: string; spanId?: string } | undefined

  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  ignoreUrlPatterns?: RegExp[]
  redactUrlPatterns?: RegExp[]

  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
}

export interface ResolvedSessionReplayConfig {
  replayUrl: string
  headers: (() => MaybePromise<Record<string, string>>) | undefined
  token: string | (() => MaybePromise<string>) | undefined
  getSessionId: (() => string | undefined) | undefined
  sessionSampleRate: number
  onErrorSampleRate: number
  maskAllInputs: boolean
  maskTextSelector: string
  blockSelector: string
  flushIntervalMs: number
  maxBufferBytes: number
  sessionIdleTimeoutMs: number
  maxSessionDurationMs: number
  distinctId: string
  getDistinctId: (() => string | undefined) | undefined
  getTraceContext: (() => { traceId?: string; spanId?: string } | undefined) | undefined
  captureConsole: boolean
  captureNetwork: boolean
  captureNavigation: boolean
  ignoreUrlPatterns: RegExp[]
  redactUrlPatterns: RegExp[]
  onError: ((error: unknown) => void) | undefined
  fetchImpl: typeof fetch
  now: () => number
  random: () => number
}

export const DEFAULTS = {
  sessionSampleRate: 1,
  onErrorSampleRate: 1,
  maskAllInputs: true,
  maskTextSelector: '',
  blockSelector: '',
  flushIntervalMs: 5_000,
  maxBufferBytes: 1_000_000,
  sessionIdleTimeoutMs: 1_800_000,
  maxSessionDurationMs: 14_400_000,
  distinctId: '',
  captureConsole: true,
  captureNetwork: true,
  captureNavigation: true,
} as const
