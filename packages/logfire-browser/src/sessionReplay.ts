import { diag } from '@opentelemetry/api'
import { warning } from 'logfire'

import type { BrowserSessionManager, BrowserUser } from './browserSession'
import type { BrowserMetricsOptions } from './browserMetrics'
import { assertBrowserReplayUrl, createTelemetryUrlPatterns } from './telemetryUrls'

import type { SessionReplayConfig as PeerSessionReplayConfig } from '@pydantic/logfire-session-replay'

export type MaybePromise<T> = T | Promise<T>

export interface BrowserSessionReplayRuntime {
  readonly recording: boolean
  readonly mode: 'full' | 'buffer' | 'off'
  getSessionId(): string
  /** Absent from replay packages older than 0.6. */
  captureError?(error: unknown, options?: { timestamp?: number }): void
  /** Present in replay packages that separate a DOM recording from its RUM session. */
  getRecordingId?(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface BrowserSessionReplayControl {
  readonly recording: boolean
  readonly mode: 'full' | 'buffer' | 'off'
  captureError(error: unknown, options?: { timestamp?: number }): void
  getRecordingId?(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface BrowserSessionReplayPackageConfig {
  replayUrl: string
  headers?: () => MaybePromise<Record<string, string>>
  token?: string | (() => MaybePromise<string>)
  getSessionId?: () => string | undefined
  getSessionAttributes?: () => Record<string, string | number | boolean | undefined>
  sessionSampleRate?: number
  onErrorSampleRate?: number
  maskAllText?: boolean
  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string
  flushIntervalMs?: number
  maxBufferBytes?: number
  /** Minimum recording duration before a replay is uploaded. Defaults to 10 seconds. */
  minSessionDurationMs?: number
  /** Static replay identity and anonymous fallback for a live identity getter. */
  distinctId?: string
  /** Explicit live replay identity. This takes precedence over rum.session.getUser. */
  getDistinctId?: () => string | undefined
  /** Current user snapshotted into each replay chunk. The browser SDK passes rum.session.getUser. */
  getUser?: () => BrowserUser | undefined
  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  captureGlobalErrors?: boolean
  ignoreUrlPatterns?: RegExp[]
  redactUrlPatterns?: RegExp[]
  transformUrl?: (url: string) => string
  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
}

export interface BrowserSessionReplayModule {
  startSessionReplay(config: BrowserSessionReplayPackageConfig): BrowserSessionReplayRuntime
}

/**
 * Early Access browser session replay options. Keep browser replay rollout
 * behind an application flag.
 */
export interface BrowserSessionReplayOptions {
  /**
   * Loads @pydantic/logfire-session-replay. Applications that do not enable
   * replay never need their bundler to resolve the optional peer.
   */
  load: () => MaybePromise<BrowserSessionReplayModule>
  /**
   * Browser-safe replay upload endpoint, either direct Logfire ingest or an
   * application-owned proxy.
   */
  replayUrl: string
  /**
   * Headers added to each replay upload. Direct Logfire ingest uses the same
   * restricted frontend application headers as traces and metrics.
   */
  headers?: () => MaybePromise<Record<string, string>>
  /**
   * Convenience token source. A non-empty value removes any case-insensitive
   * Authorization entry returned by `headers`, then sets `Authorization: Bearer`.
   * Only restricted frontend application tokens are safe in browsers.
   */
  token?: string | (() => MaybePromise<string>)

  sessionSampleRate?: number
  onErrorSampleRate?: number

  maskAllText?: boolean
  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string

  flushIntervalMs?: number
  maxBufferBytes?: number
  /** Minimum recording duration before a replay is uploaded. Defaults to 10 seconds. */
  minSessionDurationMs?: number

  /** Static replay identity and anonymous fallback for a live identity getter. */
  distinctId?: string
  /** Explicit live replay identity. This takes precedence over rum.session.getUser. */
  getDistinctId?: () => string | undefined

  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  /**
   * Whether the replay recorder installs its own uncaught error listeners. Browser global error
   * capture replaces them with forwarded errors, so this only applies when that capture is off.
   */
  captureGlobalErrors?: boolean
  ignoreUrlPatterns?: RegExp[]
  redactUrlPatterns?: RegExp[]
  /**
   * Rewrites each replay page, navigation, network, and DOM attribute URL after
   * `redactUrlPatterns` has removed its query and fragment, for example to
   * replace a token or email in the path.
   */
  transformUrl?: (url: string) => string

  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
}

export type BrowserSessionReplaySpanMode = 'full' | 'buffer'

export interface BrowserSessionReplaySpanState {
  active: true
  mode: BrowserSessionReplaySpanMode
  recordingId?: string
}

export class BrowserSessionReplayState {
  private replay: BrowserSessionReplayControl | undefined

  setReplay(replay: BrowserSessionReplayControl): void {
    this.replay = replay
  }

  clear(): void {
    this.replay = undefined
  }

  getState(): BrowserSessionReplaySpanState | undefined {
    const mode = this.replay?.mode
    if (this.replay?.recording !== true || (mode !== 'full' && mode !== 'buffer')) {
      return undefined
    }

    const recordingId = this.replay.getRecordingId?.()
    // A new recorder has no recording id during rotation. Do not link spans
    // from the new RUM session to the recorder that is still shutting down.
    if (recordingId?.length === 0) {
      return undefined
    }
    return { active: true, mode, ...(recordingId === undefined ? {} : { recordingId }) }
  }
}

interface BrowserSessionReplayTelemetryOptions {
  /** The browser SDK captures global errors and forwards them through `captureError()`. */
  capturesGlobalErrors?: boolean
  metricUrl?: BrowserMetricsOptions['metricUrl'] | undefined
  traceUrl: string
}

type ReplayConfigComparable = Omit<PeerSessionReplayConfig, 'maxSessionDurationMs' | 'now' | 'random' | 'sessionIdleTimeoutMs'>
type ReplayConfigAssignable = BrowserSessionReplayPackageConfig extends ReplayConfigComparable ? true : never
function assertReplayConfigAssignable(_value: ReplayConfigAssignable): void {
  return undefined
}
assertReplayConfigAssignable(true)

export async function startBrowserSessionReplay(
  options: BrowserSessionReplayOptions,
  browserSessionManager: BrowserSessionManager,
  replayState: BrowserSessionReplayState,
  telemetryOptions: BrowserSessionReplayTelemetryOptions
): Promise<BrowserSessionReplayControl | undefined> {
  try {
    assertBrowserReplayUrl(options.replayUrl)
    browserSessionManager.touch()
    const initialSessionId = browserSessionManager.peekSessionId()
    if (initialSessionId === undefined) {
      throw new Error('logfire-browser: sessionReplay requires an active browser session id')
    }

    const replayModule = await options.load()
    const replayConfig = createReplayConfig(options, browserSessionManager, telemetryOptions)
    const replay = replayModule.startSessionReplay(replayConfig)
    const wrappedReplay = wrapReplayRuntime(replay, replayState, options.onError)
    replayState.setReplay(wrappedReplay)
    return wrappedReplay
  } catch (error) {
    replayState.clear()
    diag.error(
      'logfire-browser: failed to start session replay; install @pydantic/logfire-session-replay and verify sessionReplay config',
      error
    )
    safeReportError(options.onError, error)
    return undefined
  }
}

function createReplayConfig(
  options: BrowserSessionReplayOptions,
  browserSessionManager: BrowserSessionManager,
  telemetryOptions: BrowserSessionReplayTelemetryOptions
): BrowserSessionReplayPackageConfig {
  const config: BrowserSessionReplayPackageConfig = {
    getSessionId: () => browserSessionManager.peekSessionId(),
    getSessionAttributes: () => browserSessionManager.peekSessionAttributes() ?? {},
    ignoreUrlPatterns: [
      ...createTelemetryUrlPatterns([
        { kind: 'exact', url: telemetryOptions.traceUrl },
        ...(telemetryOptions.metricUrl === undefined ? [] : [{ kind: 'exact' as const, url: telemetryOptions.metricUrl }]),
        { kind: 'replay-base', url: options.replayUrl },
      ]),
      ...(options.ignoreUrlPatterns ?? []),
    ],
    replayUrl: options.replayUrl,
  }

  if (options.headers !== undefined) {
    config.headers = options.headers
  }
  if (options.token !== undefined) {
    config.token = options.token
  }
  if (options.sessionSampleRate !== undefined) {
    config.sessionSampleRate = options.sessionSampleRate
  }
  if (options.onErrorSampleRate !== undefined) {
    config.onErrorSampleRate = options.onErrorSampleRate
  }
  if (options.maskAllText !== undefined) {
    config.maskAllText = options.maskAllText
  }
  if (options.maskAllInputs !== undefined) {
    config.maskAllInputs = options.maskAllInputs
  }
  if (options.maskTextSelector !== undefined) {
    config.maskTextSelector = options.maskTextSelector
  }
  if (options.blockSelector !== undefined) {
    config.blockSelector = options.blockSelector
  }
  if (options.flushIntervalMs !== undefined) {
    config.flushIntervalMs = options.flushIntervalMs
  }
  if (options.maxBufferBytes !== undefined) {
    config.maxBufferBytes = options.maxBufferBytes
  }
  if (options.minSessionDurationMs !== undefined) {
    config.minSessionDurationMs = options.minSessionDurationMs
  }
  if (options.distinctId !== undefined) {
    config.distinctId = options.distinctId
  }
  if (options.getDistinctId !== undefined) {
    config.getDistinctId = options.getDistinctId
  }
  config.getUser = () => browserSessionManager.getUser()
  if (options.captureConsole !== undefined) {
    config.captureConsole = options.captureConsole
  }
  if (options.captureNetwork !== undefined) {
    config.captureNetwork = options.captureNetwork
  }
  if (options.captureNavigation !== undefined) {
    config.captureNavigation = options.captureNavigation
  }
  if (telemetryOptions.capturesGlobalErrors === true) {
    config.captureGlobalErrors = false
  } else if (options.captureGlobalErrors !== undefined) {
    config.captureGlobalErrors = options.captureGlobalErrors
  }
  if (options.redactUrlPatterns !== undefined) {
    config.redactUrlPatterns = options.redactUrlPatterns
  }
  if (options.transformUrl !== undefined) {
    config.transformUrl = options.transformUrl
  }
  config.onError = (error) => {
    // Keep the recorder optional: inspect its public error shape without a runtime
    // import that would eagerly bundle rrweb. Do not include the payload or cause.
    try {
      if (error instanceof Error && error.name === 'ReplayUploadError' && 'reason' in error && 'sessionId' in error && 'seq' in error) {
        warning('Session replay upload was not confirmed', {
          'replay.upload.reason': error.reason,
          'replay.recording_id': error.sessionId,
          'replay.chunk.seq': error.seq,
          'replay.upload.status_code': 'status' in error ? error.status : undefined,
          'replay.upload.dropped_seqs': 'droppedSeqs' in error ? error.droppedSeqs : [],
          'replay.upload.dependent_drop_count': 'droppedSeqs' in error && Array.isArray(error.droppedSeqs) ? error.droppedSeqs.length : 0,
        })
      }
    } catch {
      // Telemetry and hostile error getters must not prevent the application's callback.
    }
    safeReportError(options.onError, error)
  }
  if (options.fetchImpl !== undefined) {
    config.fetchImpl = options.fetchImpl
  }

  return config
}

/**
 * Keeps only the message and stack that replay records, so an error held until replay starts does
 * not retain the reported value.
 */
export function snapshotErrorForReplay(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error
  }
  try {
    const { message, stack } = error as { message?: unknown; stack?: unknown }
    return {
      ...(typeof message === 'string' ? { message } : {}),
      ...(typeof stack === 'string' ? { stack } : {}),
    }
  } catch {
    return {}
  }
}

function safeReportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    const result = onError?.(error)
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch(() => undefined)
    }
  } catch {
    // Optional replay and consumer reporters must not break browser configuration.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

function wrapReplayRuntime(
  replay: BrowserSessionReplayRuntime,
  replayState: BrowserSessionReplayState,
  onError: ((error: unknown) => void) | undefined
): BrowserSessionReplayControl {
  let stopPromise: Promise<void> | undefined
  const getRecordingId = replay.getRecordingId?.bind(replay)
  return {
    ...(getRecordingId === undefined
      ? {}
      : {
          getRecordingId: () => {
            try {
              return getRecordingId()
            } catch (error) {
              safeReportError(onError, error)
              return ''
            }
          },
        }),
    get mode() {
      try {
        return replay.mode
      } catch (error) {
        safeReportError(onError, error)
        return 'off'
      }
    },
    get recording() {
      try {
        return replay.recording
      } catch (error) {
        safeReportError(onError, error)
        return false
      }
    },
    captureError: (error, options) => {
      try {
        if (options === undefined) {
          replay.captureError?.(error)
        } else {
          replay.captureError?.(error, options)
        }
      } catch (captureError) {
        safeReportError(onError, captureError)
      }
    },
    flush: async () => {
      try {
        await replay.flush()
      } catch (error) {
        safeReportError(onError, error)
      }
    },
    stop: async () => {
      stopPromise ??= (async () => {
        try {
          await replay.stop()
        } catch (error) {
          safeReportError(onError, error)
        } finally {
          replayState.clear()
        }
      })()
      return stopPromise
    },
  }
}
