import { captureConsole, captureNavigation, captureNetwork } from './capture'
import { startRecording } from './recorder'
import { decideSamplingMode } from './sampling'
import { safeSessionStorage, SessionManager } from './session'
import { ReplayTransport } from './transport'
import { CustomTag, DEFAULTS } from './types'
import type { ResolvedSessionReplayConfig, SamplingMode, SessionReplayConfig } from './types'

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
  readonly mode: 'full' | 'buffer' | 'off'
  getSessionId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

const NOOP: SessionReplay = {
  mode: 'off',
  recording: false,
  getSessionId: () => '',
  flush: async () => Promise.resolve(),
  stop: async () => Promise.resolve(),
}

const SAMPLING_MODE_STORAGE_KEY = 'lf_session_replay_mode'
const CONTROLLER_LEASE_KEY = Symbol.for('@pydantic/logfire-session-replay/controller')
const SESSION_MONITOR_INTERVAL_MS = 1_000

interface ActiveRuntime {
  readonly sessionId: string
  readonly transport: ReplayTransport
  deactivate(): Promise<void>
  discard(): void
}

export function startSessionReplay(config: SessionReplayConfig): SessionReplay {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return NOOP
  }

  const releaseLease = acquireControllerLease()
  try {
    const resolvedConfig = resolveConfig(config)
    const internalSessions = new SessionManager({
      idleTimeoutMs: resolvedConfig.sessionIdleTimeoutMs,
      maxDurationMs: resolvedConfig.maxSessionDurationMs,
      now: resolvedConfig.now,
    })
    let lastSessionId = internalSessions.getSession().id
    const getSessionId = (touch: boolean): string => {
      let externalSessionId: string | undefined
      try {
        externalSessionId = resolvedConfig.getSessionId?.()
      } catch (error) {
        safeReportError(resolvedConfig.onError, error)
        return lastSessionId
      }
      if (externalSessionId !== undefined && externalSessionId.length > 0) {
        lastSessionId = externalSessionId
        return externalSessionId
      }
      const sessionId = touch ? internalSessions.touch().id : internalSessions.getSession().id
      lastSessionId = sessionId
      return sessionId
    }
    const samplingModeStorage = safeSessionStorage()
    let currentSessionId = getSessionId(false)
    let runtime: ActiveRuntime | undefined
    let stopped = false
    let transition = Promise.resolve()
    let stopPromise: Promise<void> | undefined

    const activate = (sessionId: string, initial: boolean): void => {
      const mode = resolveSamplingMode(resolvedConfig, sessionId, samplingModeStorage)
      if (mode === 'off' || stopped || sessionId !== currentSessionId) {
        return
      }
      try {
        runtime = createActiveRuntime({
          config: resolvedConfig,
          getSessionId,
          mode,
          onSessionChanged: observeSession,
          samplingModeStorage,
          sessionId,
        })
      } catch (error) {
        runtime = undefined
        if (initial) {
          throw error
        }
        safeReportError(resolvedConfig.onError, error)
      }
    }

    const observeSession = (sessionId: string): void => {
      if (stopped || sessionId === currentSessionId) {
        return
      }
      currentSessionId = sessionId
      const oldRuntime = runtime
      runtime = undefined
      const oldShutdown = oldRuntime?.deactivate() ?? Promise.resolve()
      transition = transition.then(async () => {
        await reportPromise(oldShutdown, resolvedConfig.onError)
        if (!stopped && currentSessionId === sessionId) {
          activate(sessionId, false)
        }
      })
    }

    let sessionTimer: ReturnType<typeof setInterval>
    try {
      activate(currentSessionId, true)
      sessionTimer = setInterval(() => {
        observeSession(getSessionId(false))
      }, SESSION_MONITOR_INTERVAL_MS)
    } catch (error) {
      runtime?.discard()
      runtime = undefined
      throw error
    }

    return {
      get mode() {
        try {
          return runtime?.transport.getMode() ?? 'off'
        } catch (error) {
          safeReportError(resolvedConfig.onError, error)
          return 'off'
        }
      },
      get recording() {
        try {
          return runtime !== undefined
        } catch (error) {
          safeReportError(resolvedConfig.onError, error)
          return false
        }
      },
      getSessionId: () => getSessionId(false),
      flush: async () => {
        try {
          await transition
          await runtime?.transport.flush()
        } catch (error) {
          safeReportError(resolvedConfig.onError, error)
        }
      },
      stop: async () => {
        stopPromise ??= (async () => {
          stopped = true
          clearInterval(sessionTimer)
          const oldRuntime = runtime
          runtime = undefined
          const oldShutdown = oldRuntime?.deactivate() ?? Promise.resolve()
          await reportPromise(oldShutdown, resolvedConfig.onError)
          await transition
          internalSessions.flushPendingStorage()
          releaseLease()
        })()
        return stopPromise
      },
    }
  } catch (error) {
    releaseLease()
    throw error
  }
}

function createActiveRuntime(options: {
  config: ResolvedSessionReplayConfig
  getSessionId: (touch: boolean) => string
  mode: 'full' | 'buffer'
  onSessionChanged: (sessionId: string) => void
  samplingModeStorage: Storage | null
  sessionId: string
}): ActiveRuntime {
  const { config, getSessionId, mode, onSessionChanged, samplingModeStorage, sessionId } = options
  const transport = new ReplayTransport(config, sessionId, mode)
  const cleanup: (() => void)[] = []
  let active = true
  const isRuntimeActive = () => active
  let deactivation: Promise<void> | undefined

  try {
    const recorder = startRecording({
      emit: (event) => {
        if (!active) {
          return
        }
        try {
          const observedSessionId = getSessionId(true)
          if (observedSessionId !== sessionId) {
            onSessionChanged(observedSessionId)
            return
          }
          transport.add(event)
        } catch (error) {
          safeReportError(config.onError, error)
        }
      },
      maskAllText: config.maskAllText,
      maskAllInputs: config.maskAllInputs,
      maskTextSelector: config.maskTextSelector,
      blockSelector: config.blockSelector,
      checkoutEveryNms: mode === 'buffer' ? 120_000 : 0,
      redactUrlPatterns: config.redactUrlPatterns,
    })
    cleanup.push(() => {
      recorder.stop()
    })

    const addCustomEvent = (tag: string, payload: unknown) => {
      if (active) {
        try {
          recorder.addCustomEvent(tag, payload)
        } catch (error) {
          safeReportError(config.onError, error)
        }
      }
    }

    let lastTraceId: string | undefined
    if (config.getTraceContext !== undefined) {
      const traceTimer = setInterval(() => {
        if (!active) {
          return
        }
        try {
          const context = config.getTraceContext?.()
          const traceId = context?.traceId
          if (traceId !== undefined && traceId.length > 0 && traceId !== lastTraceId) {
            lastTraceId = traceId
            addCustomEvent(CustomTag.Trace, { traceId, spanId: context?.spanId })
          }
        } catch (error) {
          safeReportError(config.onError, error)
        }
      }, SESSION_MONITOR_INTERVAL_MS)
      cleanup.push(() => {
        clearInterval(traceTimer)
      })
    }

    const handleError = (payload: { message: string; source?: string; stack?: string }) => {
      if (!isRuntimeActive()) {
        return
      }
      addCustomEvent(CustomTag.Error, payload)
      if (!isRuntimeActive()) {
        return
      }
      if (transport.getMode() === 'buffer') {
        saveSamplingMode(samplingModeStorage, sessionId, 'full')
        ignorePromise(transport.triggerFlush(), config.onError)
      }
    }
    const onWindowError = (event: ErrorEvent) => {
      handleError(createErrorPayload(event.message, event.filename, errorStack(event.error)))
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: unknown; stack?: unknown } | undefined
      const message = coerceRejectionMessage(reason?.message ?? event.reason)
      handleError(createErrorPayload(message, undefined, typeof reason?.stack === 'string' ? reason.stack : undefined))
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        ignorePromise(transport.flush({ keepalive: true }), config.onError)
      }
    }
    const onPageHide = () => {
      ignorePromise(transport.flush({ keepalive: true }), config.onError)
    }
    window.addEventListener('error', onWindowError, true)
    cleanup.push(() => {
      window.removeEventListener('error', onWindowError, true)
    })
    window.addEventListener('unhandledrejection', onRejection, true)
    cleanup.push(() => {
      window.removeEventListener('unhandledrejection', onRejection, true)
    })
    document.addEventListener('visibilitychange', onVisibilityChange)
    cleanup.push(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    })
    window.addEventListener('pagehide', onPageHide)
    cleanup.push(() => {
      window.removeEventListener('pagehide', onPageHide)
    })

    if (config.captureConsole) {
      cleanup.push(captureConsole(addCustomEvent, { onError: config.onError }))
    }
    if (config.captureNetwork) {
      cleanup.push(
        captureNetwork(addCustomEvent, {
          ignoreUrlPatterns: config.ignoreUrlPatterns,
          now: config.now,
          onError: config.onError,
          redactUrlPatterns: config.redactUrlPatterns,
        })
      )
    }
    if (config.captureNavigation) {
      cleanup.push(
        captureNavigation(addCustomEvent, {
          onError: config.onError,
          redactUrlPatterns: config.redactUrlPatterns,
        })
      )
    }
    transport.start()

    return {
      sessionId,
      transport,
      deactivate: async () => {
        deactivation ??= (async () => {
          active = false
          stopCleanup(cleanup)
          await transport.shutdown({ keepalive: false })
        })()
        return deactivation
      },
      discard: () => {
        active = false
        stopCleanup(cleanup)
        transport.discard()
      },
    }
  } catch (error) {
    active = false
    stopCleanup(cleanup)
    transport.discard()
    throw error
  }
}

function resolveConfig(config: SessionReplayConfig): ResolvedSessionReplayConfig {
  if (config.replayUrl.length === 0) {
    throw new Error('logfire session replay: `replayUrl` is required')
  }
  const replayUrl = new URL(config.replayUrl, 'https://logfire.invalid/')
  if (replayUrl.search !== '' || replayUrl.hash !== '') {
    throw new Error('logfire session replay: `replayUrl` must not contain a query or fragment')
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
    maskAllText: config.maskAllText ?? DEFAULTS.maskAllText,
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
    ignoreUrlPatterns: config.ignoreUrlPatterns ?? [],
    redactUrlPatterns: config.redactUrlPatterns ?? [...DEFAULTS.redactUrlPatterns],
    onError: config.onError,
    fetchImpl,
    now: config.now ?? Date.now,
    random: config.random ?? Math.random,
  }
}

function resolveSamplingMode(config: ResolvedSessionReplayConfig, sessionId: string, storage: Storage | null): SamplingMode {
  const persistedMode = loadSamplingMode(storage, sessionId)
  if (persistedMode !== undefined) {
    return persistedMode
  }

  const mode = decideSamplingMode({
    sessionSampleRate: config.sessionSampleRate,
    onErrorSampleRate: config.onErrorSampleRate,
    random: config.random,
  })
  saveSamplingMode(storage, sessionId, mode)
  return mode
}

function loadSamplingMode(storage: Storage | null, sessionId: string): SamplingMode | undefined {
  if (storage === null) {
    return undefined
  }

  try {
    const raw = storage.getItem(SAMPLING_MODE_STORAGE_KEY)
    if (raw === null) {
      return undefined
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }
    const state = parsed as { id?: unknown; mode?: unknown }
    if (state.id !== sessionId || !isSamplingMode(state.mode)) {
      return undefined
    }
    return state.mode
  } catch {
    return undefined
  }
}

function saveSamplingMode(storage: Storage | null, sessionId: string, mode: SamplingMode): void {
  if (storage === null) {
    return
  }

  try {
    storage.setItem(SAMPLING_MODE_STORAGE_KEY, JSON.stringify({ id: sessionId, mode }))
  } catch {
    // Cross-page sampling consistency is best-effort.
  }
}

function isSamplingMode(value: unknown): value is SamplingMode {
  return value === 'full' || value === 'buffer' || value === 'off'
}

function errorStack(error: unknown): string | undefined {
  const stack = typeof error === 'object' && error !== null && 'stack' in error ? (error as { stack?: unknown }).stack : undefined
  return typeof stack === 'string' ? stack : undefined
}

function ignorePromise(promise: Promise<void>, onError: ((error: unknown) => void) | undefined): void {
  promise.catch((error: unknown) => {
    safeReportError(onError, error)
  })
}

async function reportPromise(promise: Promise<void>, onError: ((error: unknown) => void) | undefined): Promise<void> {
  try {
    await promise
  } catch (error) {
    safeReportError(onError, error)
  }
}

function safeReportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    const result = onError?.(error)
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch(() => undefined)
    }
  } catch {
    // Error reporting must never break the host application.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

function acquireControllerLease(): () => void {
  const target = globalThis as Record<PropertyKey, unknown>
  if (target[CONTROLLER_LEASE_KEY] !== undefined) {
    throw new Error('logfire session replay: a replay controller is already active in this page')
  }
  const owner = {}
  Object.defineProperty(target, CONTROLLER_LEASE_KEY, {
    configurable: true,
    enumerable: false,
    value: owner,
    writable: true,
  })
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    if (target[CONTROLLER_LEASE_KEY] === owner) {
      Reflect.deleteProperty(target, CONTROLLER_LEASE_KEY)
    }
  }
}

function stopCleanup(cleanup: (() => void)[]): void {
  for (let index = cleanup.length - 1; index >= 0; index -= 1) {
    try {
      cleanup[index]?.()
    } catch {
      // Transactional cleanup continues through every installed resource.
    }
  }
  cleanup.length = 0
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

function coerceRejectionMessage(value: unknown): string {
  if (value === undefined || value === null) {
    return 'unhandledrejection'
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value)
  }
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
