import { captureConsole, captureNavigation, captureNetwork } from './capture'
import { startRecording } from './recorder'
import type { RecorderHandle } from './recorder'
import { decideSamplingMode } from './sampling'
import { SessionManager } from './session'
import { ReplayTransport } from './transport'
import { CustomTag, DEFAULTS } from './types'
import type { ResolvedSessionReplayConfig, SessionReplayConfig } from './types'

export type {
  ChunkEnvelope,
  ChunkMeta,
  ConsolePayload,
  NavigationPayload,
  NetworkPayload,
  RrwebEvent,
  SamplingMode,
  SessionReplayConfig,
} from './types'
export { CHUNK_ENVELOPE_VERSION, CustomTag, EventType, IncrementalSource, MouseInteractions } from './types'

export interface SessionReplay {
  readonly recording: boolean
  getSessionId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

const NOOP: SessionReplay = {
  recording: false,
  getSessionId: () => '',
  flush: async () => Promise.resolve(),
  stop: async () => Promise.resolve(),
}

export function startSessionReplay(config: SessionReplayConfig): SessionReplay {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return NOOP
  }

  const resolvedConfig = resolveConfig(config)
  const mode = decideSamplingMode({
    sessionSampleRate: resolvedConfig.sessionSampleRate,
    onErrorSampleRate: resolvedConfig.onErrorSampleRate,
    random: resolvedConfig.random,
  })

  if (mode === 'off') {
    return NOOP
  }

  const internalSessions = new SessionManager({
    idleTimeoutMs: resolvedConfig.sessionIdleTimeoutMs,
    maxDurationMs: resolvedConfig.maxSessionDurationMs,
    now: resolvedConfig.now,
  })
  const getSessionId = (touch: boolean): string => {
    const externalSessionId = resolvedConfig.getSessionId?.()
    if (externalSessionId !== undefined && externalSessionId.length > 0) {
      return externalSessionId
    }
    return touch ? internalSessions.touch().id : internalSessions.getSession().id
  }

  const transport = new ReplayTransport(resolvedConfig, getSessionId(false), mode)
  const recorderRef: { current?: RecorderHandle } = {}
  const recorder = startRecording({
    emit: (event) => {
      const sessionId = getSessionId(true)
      if (transport.rotate(sessionId)) {
        recorderRef.current?.takeFullSnapshot()
      }
      transport.add(event)
    },
    maskAllInputs: resolvedConfig.maskAllInputs,
    maskTextSelector: resolvedConfig.maskTextSelector,
    blockSelector: resolvedConfig.blockSelector,
    checkoutEveryNms: mode === 'buffer' ? 120_000 : 0,
  })
  recorderRef.current = recorder

  let lastTraceId: string | undefined
  const traceTimer =
    resolvedConfig.getTraceContext === undefined
      ? undefined
      : setInterval(() => {
          const context = resolvedConfig.getTraceContext?.()
          const traceId = context?.traceId
          if (traceId !== undefined && traceId.length > 0 && traceId !== lastTraceId) {
            lastTraceId = traceId
            recorder.addCustomEvent(CustomTag.Trace, { traceId, spanId: context?.spanId })
          }
        }, 1_000)

  const handleError = (payload: { message: string; source?: string; stack?: string }) => {
    recorder.addCustomEvent(CustomTag.Error, payload)
    if (transport.getMode() === 'buffer') {
      ignorePromise(transport.triggerFlush(), resolvedConfig.onError)
    }
  }
  const onWindowError = (event: ErrorEvent) => {
    handleError(createErrorPayload(event.message, event.filename, errorStack(event.error)))
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined
    handleError(createErrorPayload(reason?.message ?? String(event.reason ?? 'unhandledrejection'), undefined, reason?.stack))
  }
  const onHide = () => {
    if (document.visibilityState === 'hidden') {
      ignorePromise(transport.flush({ keepalive: true }), resolvedConfig.onError)
    }
  }

  window.addEventListener('error', onWindowError, true)
  window.addEventListener('unhandledrejection', onRejection, true)
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', onHide)

  const addCustomEvent = (tag: string, payload: unknown) => {
    recorder.addCustomEvent(tag, payload)
  }
  const stopConsole = resolvedConfig.captureConsole ? captureConsole(addCustomEvent) : noop
  const stopNetwork = resolvedConfig.captureNetwork
    ? captureNetwork(addCustomEvent, { redactUrlPatterns: resolvedConfig.redactUrlPatterns, now: resolvedConfig.now })
    : noop
  const stopNavigation = resolvedConfig.captureNavigation ? captureNavigation(addCustomEvent) : noop

  transport.start()

  let stopPromise: Promise<void> | undefined
  return {
    recording: true,
    getSessionId: () => getSessionId(false),
    flush: async () => transport.flush(),
    stop: async () => {
      stopPromise ??= (async () => {
        if (traceTimer !== undefined) {
          clearInterval(traceTimer)
        }
        window.removeEventListener('error', onWindowError, true)
        window.removeEventListener('unhandledrejection', onRejection, true)
        document.removeEventListener('visibilitychange', onHide)
        window.removeEventListener('pagehide', onHide)
        stopConsole()
        stopNetwork()
        stopNavigation()
        recorder.stop()
        await transport.shutdown({ keepalive: true })
      })()
      return stopPromise
    },
  }
}

function resolveConfig(config: SessionReplayConfig): ResolvedSessionReplayConfig {
  if (config.replayUrl.length === 0) {
    throw new Error('logfire session replay: `replayUrl` is required')
  }
  const fetchImpl = config.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined)
  if (fetchImpl === undefined) {
    throw new Error('logfire session replay: no `fetch` available; pass `fetchImpl`')
  }

  return {
    replayUrl: config.replayUrl,
    headers: config.headers,
    token: config.token,
    getSessionId: config.getSessionId,
    sessionSampleRate: config.sessionSampleRate ?? DEFAULTS.sessionSampleRate,
    onErrorSampleRate: config.onErrorSampleRate ?? DEFAULTS.onErrorSampleRate,
    maskAllInputs: config.maskAllInputs ?? DEFAULTS.maskAllInputs,
    maskTextSelector: config.maskTextSelector ?? DEFAULTS.maskTextSelector,
    blockSelector: config.blockSelector ?? DEFAULTS.blockSelector,
    flushIntervalMs: config.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    maxBufferBytes: config.maxBufferBytes ?? DEFAULTS.maxBufferBytes,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs ?? DEFAULTS.sessionIdleTimeoutMs,
    maxSessionDurationMs: config.maxSessionDurationMs ?? DEFAULTS.maxSessionDurationMs,
    distinctId: config.distinctId ?? DEFAULTS.distinctId,
    getDistinctId: config.getDistinctId,
    getTraceContext: config.getTraceContext,
    captureConsole: config.captureConsole ?? DEFAULTS.captureConsole,
    captureNetwork: config.captureNetwork ?? DEFAULTS.captureNetwork,
    captureNavigation: config.captureNavigation ?? DEFAULTS.captureNavigation,
    redactUrlPatterns: config.redactUrlPatterns ?? [],
    onError: config.onError,
    fetchImpl,
    now: config.now ?? Date.now,
    random: config.random ?? Math.random,
  }
}

function errorStack(error: unknown): string | undefined {
  const stack = typeof error === 'object' && error !== null && 'stack' in error ? (error as { stack?: unknown }).stack : undefined
  return typeof stack === 'string' ? stack : undefined
}

function noop(): undefined {
  return undefined
}

function ignorePromise(promise: Promise<void>, onError: ((error: unknown) => void) | undefined): void {
  promise.catch((error: unknown) => {
    onError?.(error)
  })
}

function createErrorPayload(
  message: string,
  source: string | undefined,
  stack: string | undefined
): {
  message: string
  source?: string
  stack?: string
} {
  return {
    message,
    ...(source === undefined || source.length === 0 ? {} : { source }),
    ...(stack === undefined ? {} : { stack }),
  }
}
