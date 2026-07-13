import { diag } from '@opentelemetry/api'

import type { BrowserSessionManager } from './browserSession'
import type { BrowserMetricsOptions } from './browserMetrics'
import { assertBrowserReplayUrl, createTelemetryUrlPatterns } from './telemetryUrls'

import type { SessionReplayConfig as PeerSessionReplayConfig } from '@pydantic/logfire-session-replay'

export type MaybePromise<T> = T | Promise<T>

export interface BrowserSessionReplayRuntime {
  readonly recording: boolean
  readonly mode: 'full' | 'buffer' | 'off'
  getSessionId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface BrowserSessionReplayPackageConfig {
  replayUrl: string
  headers?: () => MaybePromise<Record<string, string>>
  token?: string | (() => MaybePromise<string>)
  getSessionId?: () => string | undefined
  sessionSampleRate?: number
  onErrorSampleRate?: number
  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string
  flushIntervalMs?: number
  maxBufferBytes?: number
  distinctId?: string
  getDistinctId?: () => string | undefined
  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  ignoreUrlPatterns?: RegExp[]
  redactUrlPatterns?: RegExp[]
  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
}

export interface BrowserSessionReplayModule {
  startSessionReplay(config: BrowserSessionReplayPackageConfig): BrowserSessionReplayRuntime
}

/**
 * Experimental browser session replay options.
 *
 * Logfire Platform replay ingest and playback are still feature-flagged, so
 * keep browser replay rollout behind an application flag.
 */
export interface BrowserSessionReplayOptions {
  /**
   * Loads @pydantic/logfire-session-replay. Applications that do not enable
   * replay never need their bundler to resolve the optional peer.
   */
  load: () => MaybePromise<BrowserSessionReplayModule>
  /**
   * Replay upload endpoint. Browser apps should normally point this at a
   * backend proxy.
   */
  replayUrl: string
  /**
   * Headers added to each replay upload, usually for authenticating to the
   * caller's backend proxy.
   */
  headers?: () => MaybePromise<Record<string, string>>
  /**
   * Advanced direct-ingest escape hatch. Prefer replayUrl + headers through a
   * backend proxy for browser applications.
   */
  token?: string | (() => MaybePromise<string>)

  sessionSampleRate?: number
  onErrorSampleRate?: number

  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string

  flushIntervalMs?: number
  maxBufferBytes?: number

  distinctId?: string
  getDistinctId?: () => string | undefined

  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  ignoreUrlPatterns?: RegExp[]
  redactUrlPatterns?: RegExp[]

  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
}

export type BrowserSessionReplaySpanMode = 'full' | 'buffer'

export interface BrowserSessionReplaySpanState {
  active: true
  mode: BrowserSessionReplaySpanMode
}

export class BrowserSessionReplayState {
  private replay: BrowserSessionReplayRuntime | undefined

  setReplay(replay: BrowserSessionReplayRuntime): void {
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

    return { active: true, mode }
  }
}

interface BrowserSessionReplayTelemetryOptions {
  metricUrl?: BrowserMetricsOptions['metricUrl'] | undefined
  traceUrl: string
}

type ReplayConfigComparable = Omit<
  PeerSessionReplayConfig,
  'getTraceContext' | 'maxSessionDurationMs' | 'now' | 'random' | 'sessionIdleTimeoutMs'
>
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
): Promise<BrowserSessionReplayRuntime | undefined> {
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
    ignoreUrlPatterns: [
      ...createTelemetryUrlPatterns([
        { kind: 'exact', url: telemetryOptions.traceUrl },
        ...(telemetryOptions.metricUrl === undefined ? [] : [{ kind: 'exact' as const, url: telemetryOptions.metricUrl }]),
        { kind: 'replay-base', url: options.replayUrl },
      ]),
      ...(options.ignoreUrlPatterns ?? []),
    ],
    redactUrlPatterns: options.redactUrlPatterns ?? [],
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
  if (options.distinctId !== undefined) {
    config.distinctId = options.distinctId
  }
  if (options.getDistinctId !== undefined) {
    config.getDistinctId = options.getDistinctId
  }
  if (options.captureConsole !== undefined) {
    config.captureConsole = options.captureConsole
  }
  if (options.captureNetwork !== undefined) {
    config.captureNetwork = options.captureNetwork
  }
  if (options.captureNavigation !== undefined) {
    config.captureNavigation = options.captureNavigation
  }
  if (options.onError !== undefined) {
    config.onError = (error) => {
      safeReportError(options.onError, error)
    }
  }
  if (options.fetchImpl !== undefined) {
    config.fetchImpl = options.fetchImpl
  }

  return config
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
): BrowserSessionReplayRuntime {
  let stopPromise: Promise<void> | undefined
  let lastSessionId = ''
  return {
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
    flush: async () => {
      try {
        await replay.flush()
      } catch (error) {
        safeReportError(onError, error)
      }
    },
    getSessionId: () => {
      try {
        const sessionId = replay.getSessionId()
        if (sessionId.length > 0) {
          lastSessionId = sessionId
        }
        return sessionId
      } catch (error) {
        safeReportError(onError, error)
        return lastSessionId
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
