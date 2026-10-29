import { isUserActivityEvent } from './activity'
import { captureConsole, captureNavigation, captureNetwork } from './capture'
import { startRecording } from './recorder'
import { MAX_RECORDING_DURATION_MS, RECORDING_STORAGE_KEY, RecordingIdentity } from './recordingIdentity'
import { claimRecordingLock, recordingLockManager } from './recordingLock'
import type { RecordingLock } from './recordingLock'
import { decideSamplingMode } from './sampling'
import { SequenceRecords, writableLocalStorage } from './sequenceRecord'
import { snapshotSessionAttributes } from './sessionAttributes'
import { safeSessionStorage, SessionManager } from './session'
import { ReplayTransport } from './transport'
import type { SequenceRecordBinding } from './transport'
import { CustomTag, DEFAULTS } from './types'
import type { ResolvedSessionReplayConfig, SamplingMode, SessionReplayConfig } from './types'

export type {
  ChunkEnvelope,
  ChunkMeta,
  ConsolePayload,
  NavigationPayload,
  NetworkPayload,
  ReplayUser,
  RrwebEvent,
  SamplingMode,
  SessionAttributes,
  SessionAttributesInput,
  SessionAttributeValue,
  SessionReplayConfig,
} from './types'
export { CHUNK_ENVELOPE_VERSION, CustomTag, EventType, IncrementalSource, MouseInteractions } from './types'
export { ReplayUploadError } from './uploadError'
export type { ReplayUploadErrorInit, ReplayUploadFailureReason } from './uploadError'

export interface SessionReplay {
  readonly recording: boolean
  readonly mode: 'full' | 'buffer' | 'off'
  /**
   * Whether a `full` recording passed its minimum duration and uploads what it records. Until then
   * the visit can end without a replay, so spans should not link to it.
   */
  readonly uploading: boolean
  getSessionId(): string
  /**
   * Add an error to the replay and promote an error-sampled buffer, as an uncaught error does.
   * The same error object is added once, however many times it is captured. Pass the time the
   * error occurred, in epoch milliseconds, when it is captured later; the error event records it
   * as `timestamp`.
   */
  captureError(error: unknown, options?: CaptureErrorOptions): void
  /** The current DOM recording's upload/playback id; distinct from the RUM session id. */
  getRecordingId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface CaptureErrorOptions {
  timestamp?: number
}

const NOOP: SessionReplay = {
  mode: 'off',
  recording: false,
  uploading: false,
  getSessionId: () => '',
  captureError: () => undefined,
  getRecordingId: () => '',
  flush: async () => Promise.resolve(),
  stop: async () => Promise.resolve(),
}

const SAMPLING_MODE_STORAGE_KEY = 'lf_session_replay_mode'
const CONTROLLER_LEASE_KEY = Symbol.for('@pydantic/logfire-session-replay/controller')
const SESSION_MONITOR_INTERVAL_MS = 1_000

/** Web Locks and a shared sequence record, which together let one document at a time write a recording. */
interface Coordination {
  locks: LockManager
  records: SequenceRecords
}

interface ClaimedRecording {
  recordingId: string
  sequenceRecord: SequenceRecordBinding
}

interface ActiveRuntime {
  readonly sessionId: string
  readonly recordingId: string
  readonly transport: ReplayTransport
  captureError(error: unknown, options?: CaptureErrorOptions): void
  deactivate(keepalive?: boolean): Promise<void>
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
    const recordingIdentity = new RecordingIdentity(samplingModeStorage, resolvedConfig.now, resolvedConfig.maxSessionDurationMs, () => {
      const opener = window.opener as Window | null
      return opener?.sessionStorage.getItem(RECORDING_STORAGE_KEY) ?? null
    })
    const coordination = resolveCoordination(resolvedConfig.now)
    let currentSessionId = getSessionId(false)
    let currentRecordingId = recordingIdentity.get(currentSessionId)
    let runtime: ActiveRuntime | undefined
    let stopped = false
    let suspended = false
    let lifecycleGeneration = 0
    let sequenceIsResumable = true
    let transition = Promise.resolve()
    let pageShutdowns = Promise.resolve()
    let stopPromise: Promise<void> | undefined
    let heldLock: { recordingId: string; lock: RecordingLock } | undefined
    let claimAbort: AbortController | undefined
    // Whether the runtime records a resumed recording whose lock is still pending. Another document
    // can hold that recording, so spans are not linked to it until the lock is granted.
    let runtimeResumed = false

    const releaseLock = (recordingId?: string): void => {
      if (heldLock !== undefined && (recordingId === undefined || heldLock.recordingId === recordingId)) {
        heldLock.lock.release()
        heldLock = undefined
      }
    }

    const activate = (sessionId: string, initial: boolean, holdUntilActivity = !initial, awaitBinding = false): void => {
      const mode = resolveSamplingMode(resolvedConfig, sessionId, samplingModeStorage)
      if (mode === 'off' || stopped || suspended || runtime !== undefined || sessionId !== currentSessionId) {
        return
      }
      try {
        runtimeResumed = awaitBinding && recordingIdentity.candidate(sessionId).resumed
        const recordingId = currentRecordingId
        runtime = createActiveRuntime({
          config: resolvedConfig,
          getSessionId,
          mode,
          onSessionChanged: observeSession,
          samplingModeStorage,
          sessionId,
          recordingId,
          isCurrentRecording: () => recordingIdentity.isCurrent(recordingId, getSessionId(false)),
          holdUntilActivity,
          awaitBinding,
          // A rotated or restored recording would be rejected in the same way, so the whole controller stops.
          // The rejection can come from an earlier pagehide upload after a restored recording started,
          // and a graceful stop would still send that recording's buffered tail.
          onPermanentRejection: () => {
            runtime?.transport.abandon()
            ignorePromise(stop(), resolvedConfig.onError)
          },
        })
      } catch (error) {
        runtime = undefined
        if (initial) {
          throw error
        }
        safeReportError(resolvedConfig.onError, error)
      }
    }

    const bindSequenceRecord = (lockCoordination: Coordination, recordingId: string, initialSeq: number): SequenceRecordBinding => ({
      initialSeq,
      write: (seq) => lockCoordination.records.write(recordingId, seq),
      onFailure: () => {
        // The transport reports the failure inside its own reservation, so switch afterwards.
        queueMicrotask(() => {
          if (!stopped && currentRecordingId === recordingId) {
            recordingIdentity.replace(currentSessionId)
            // The page was recording, so the new recording starts without waiting for activity.
            observeSession(currentSessionId, false)
          }
        })
      },
    })

    /** Hold the lock of the session's recording, starting a new recording when that is not safe. */
    const claim = async (lockCoordination: Coordination, sessionId: string, generation: number): Promise<ClaimedRecording | undefined> => {
      claimAbort?.abort()
      const lifecycle = new AbortController()
      claimAbort = lifecycle
      const isStale = (): boolean =>
        lifecycle.signal.aborted || stopped || suspended || lifecycleGeneration !== generation || currentSessionId !== sessionId
      let candidate = recordingIdentity.candidate(sessionId)
      currentRecordingId = candidate.id
      const startNewRecording = (): void => {
        candidate = { id: recordingIdentity.replace(sessionId), resumed: false }
        currentRecordingId = candidate.id
      }
      // A candidate can need one replacement, which is always a new recording.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a replacement is claimed only after the first claim fails.
        const result = await claimRecordingLock(lockCoordination.locks, candidate.id, lifecycle.signal)
        if (result.kind === 'aborted') {
          return undefined
        }
        if (result.kind === 'timeout') {
          // Another live document writes this recording.
          startNewRecording()
          continue
        }
        if (isStale() || currentRecordingId !== candidate.id) {
          result.lock.release()
          return undefined
        }
        let initialSeq: number | undefined
        if (candidate.resumed) {
          initialSeq = lockCoordination.records.read(candidate.id)
        } else if (lockCoordination.records.write(candidate.id, 0)) {
          initialSeq = 0
        }
        if (initialSeq === undefined) {
          // A resumed recording has no shared record of where the earlier writer stopped. A new
          // recording's first write can fail for a moment, for example when another tab fills the quota.
          // Nothing retries later in this session, so try once more under a new recording.
          result.lock.release()
          startNewRecording()
          continue
        }
        heldLock = { recordingId: candidate.id, lock: result.lock }
        return { recordingId: candidate.id, sequenceRecord: bindSequenceRecord(lockCoordination, candidate.id, initialSeq) }
      }
      safeReportError(resolvedConfig.onError, new Error('logfire session replay: could not claim a replay recording'))
      return undefined
    }

    /** Claim the runtime's recording, then let its transport reserve sequences and send. */
    const bindClaim = async (
      lockCoordination: Coordination,
      sessionId: string,
      generation: number,
      holdUntilActivity: boolean
    ): Promise<void> => {
      try {
        const claimed = await claim(lockCoordination, sessionId, generation)
        const isCurrent = !stopped && !suspended && lifecycleGeneration === generation && currentSessionId === sessionId
        if (claimed === undefined) {
          if (isCurrent && runtime?.transport.isAwaitingBinding() === true) {
            // The recording cannot be written safely, so its buffered events are dropped.
            runtime.discard()
            runtime = undefined
          }
          return
        }
        if (!isCurrent) {
          releaseLock(claimed.recordingId)
          return
        }
        if (runtime !== undefined && runtime.recordingId !== claimed.recordingId) {
          // The claim replaced the candidate. The buffered events belong to a recording this document
          // does not own, so recording restarts under the new ID.
          runtime.discard()
          runtime = undefined
          activate(sessionId, false, holdUntilActivity, true)
        }
        if (runtime === undefined || runtime.recordingId !== claimed.recordingId) {
          releaseLock(claimed.recordingId)
          return
        }
        runtimeResumed = false
        runtime.transport.bind(claimed.sequenceRecord)
      } catch (error) {
        safeReportError(resolvedConfig.onError, error)
      }
    }

    const activateAndClaim = async (sessionId: string, generation: number, holdUntilActivity: boolean): Promise<void> => {
      activate(sessionId, false, holdUntilActivity, coordination !== undefined)
      if (coordination !== undefined && runtime !== undefined) {
        await bindClaim(coordination, sessionId, generation, holdUntilActivity)
      }
    }

    const observeSession = (sessionId: string, holdUntilActivity = true): void => {
      if (stopped || suspended) {
        return
      }
      const recordingId = recordingIdentity.get(sessionId)
      if (sessionId === currentSessionId && recordingId === currentRecordingId) {
        return
      }
      const oldRecordingId = currentRecordingId
      currentSessionId = sessionId
      currentRecordingId = recordingId
      claimAbort?.abort()
      const oldRuntime = runtime
      runtime = undefined
      const oldShutdown = oldRuntime?.deactivate() ?? Promise.resolve()
      const generation = lifecycleGeneration
      transition = transition.then(async () => {
        await reportPromise(oldShutdown, resolvedConfig.onError)
        // The old recording's final uploads were reserved under its lock.
        releaseLock(oldRecordingId)
        if (!stopped && lifecycleGeneration === generation && currentSessionId === sessionId && currentRecordingId === recordingId) {
          await activateAndClaim(sessionId, generation, holdUntilActivity)
        }
      })
    }

    let sessionTimer: ReturnType<typeof setInterval>
    try {
      if (coordination === undefined) {
        activate(currentSessionId, true)
      } else {
        coordination.records.prune(MAX_RECORDING_DURATION_MS)
        // Recording starts at once, as without coordination. Only sequence reservation waits for the lock.
        activate(currentSessionId, true, false, true)
        if (runtime !== undefined) {
          const sessionId = currentSessionId
          const generation = lifecycleGeneration
          transition = transition.then(async () => bindClaim(coordination, sessionId, generation, false))
        }
      }
      sessionTimer = setInterval(() => {
        observeSession(getSessionId(false))
      }, SESSION_MONITOR_INTERVAL_MS)
    } catch (error) {
      runtime?.discard()
      runtime = undefined
      claimAbort?.abort()
      releaseLock()
      recordingIdentity.release()
      throw error
    }

    const onPageHide = () => {
      suspended = true
      lifecycleGeneration += 1
      claimAbort?.abort()
      const oldRuntime = runtime
      runtime = undefined
      const shutdown = oldRuntime?.deactivate(true) ?? Promise.resolve()
      // deactivate() reserved the final sequences synchronously. Releasing the lock now keeps the page
      // eligible for the back-forward cache, and lets the next document of this tab take the recording.
      releaseLock()
      // Sequences are reserved synchronously. Keep upload completion for stop(),
      // but let a restored document record while the old requests are pending.
      pageShutdowns = Promise.all([pageShutdowns, transition, reportPromise(shutdown, resolvedConfig.onError)]).then(() => undefined)
      transition = Promise.resolve()
      sequenceIsResumable = oldRuntime?.transport.canResumeSequence() ?? sequenceIsResumable
      if (sequenceIsResumable) {
        recordingIdentity.release()
      }
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || stopped) {
        return
      }
      // A cached document's old transport has a stale sequence and DOM mirror
      // after visiting another page. Resume from storage with a fresh recorder.
      runtime?.discard()
      runtime = undefined
      const generation = lifecycleGeneration
      transition = transition.then(async () => {
        const isStale = () => stopped || lifecycleGeneration !== generation
        if (isStale()) {
          return
        }
        const lifecycle = new AbortController()
        claimAbort = lifecycle
        let handover: RecordingLock | undefined
        let handoverTimedOut = false
        if (coordination !== undefined) {
          // Incoming pageshow can precede the outgoing pagehide by more than one task.
          // Read ownership and the final sequence only after that writer releases its lock.
          const claim = await claimRecordingLock(coordination.locks, currentRecordingId, lifecycle.signal)
          if (claim.kind === 'aborted') {
            return
          }
          if (claim.kind === 'held') {
            handover = claim.lock
          }
          handoverTimedOut = claim.kind === 'timeout'
        } else {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0)
          })
        }
        try {
          if (isStale()) {
            return
          }
          suspended = false
          recordingIdentity.resume()
          currentSessionId = getSessionId(false)
          // Do not wait twice for a writer that already exhausted the handover budget.
          // A fresh identity cannot collide with its still-reserved sequences.
          currentRecordingId = handoverTimedOut ? recordingIdentity.replace(currentSessionId) : recordingIdentity.get(currentSessionId)
          sequenceIsResumable = true
        } finally {
          handover?.release()
        }
        await activateAndClaim(currentSessionId, generation, false)
      })
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    const stop = async (): Promise<void> => {
      stopPromise ??= (async () => {
        stopped = true
        lifecycleGeneration += 1
        claimAbort?.abort()
        clearInterval(sessionTimer)
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('pageshow', onPageShow)
        const oldRuntime = runtime
        runtime = undefined
        const oldShutdown = oldRuntime?.deactivate() ?? Promise.resolve()
        await reportPromise(oldShutdown, resolvedConfig.onError)
        await transition
        await pageShutdowns
        internalSessions.flushPendingStorage()
        sequenceIsResumable = oldRuntime?.transport.canResumeSequence() ?? sequenceIsResumable
        if (sequenceIsResumable) {
          recordingIdentity.release()
        }
        releaseLock()
        releaseLease()
      })()
      return stopPromise
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
      get uploading() {
        try {
          return runtime?.transport.isCommitted() ?? false
        } catch (error) {
          safeReportError(resolvedConfig.onError, error)
          return false
        }
      },
      getSessionId: () => getSessionId(false),
      captureError: (error, options) => {
        try {
          runtime?.captureError(error, options)
        } catch (reportingError) {
          safeReportError(resolvedConfig.onError, reportingError)
        }
      },
      getRecordingId: () => {
        if (runtime === undefined || (runtimeResumed && runtime.transport.isAwaitingBinding())) {
          return ''
        }
        return recordingIdentity.isCurrent(runtime.recordingId, getSessionId(false)) ? runtime.recordingId : ''
      },
      flush: async () => {
        try {
          await transition
          await runtime?.transport.flush()
        } catch (error) {
          safeReportError(resolvedConfig.onError, error)
        }
      },
      stop,
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
  onSessionChanged: (sessionId: string, holdUntilActivity?: boolean) => void
  samplingModeStorage: Storage | null
  sessionId: string
  recordingId: string
  isCurrentRecording: () => boolean
  holdUntilActivity: boolean
  awaitBinding: boolean
  onPermanentRejection: () => void
}): ActiveRuntime {
  const {
    config,
    getSessionId,
    holdUntilActivity,
    mode,
    onSessionChanged,
    samplingModeStorage,
    sessionId,
    recordingId,
    isCurrentRecording,
    awaitBinding,
    onPermanentRejection,
  } = options
  const sessionAttributes = snapshotSessionAttributes(config.getSessionAttributes, (error) => {
    safeReportError(config.onError, error)
  })
  let recorder: ReturnType<typeof startRecording>
  const transport = new ReplayTransport(config, recordingId, mode, undefined, undefined, sessionAttributes, {
    holdUntilActivity,
    takeFullSnapshot: () => {
      recorder.takeFullSnapshot()
    },
    awaitBinding,
    onPermanentRejection,
  })
  const cleanup: (() => void)[] = []
  let active = true
  const isRuntimeActive = () => active
  let deactivation: Promise<void> | undefined

  try {
    recorder = startRecording({
      beforeUserActivity: () => {
        if (!active || !transport.isHeld()) {
          return
        }
        try {
          const observedSessionId = getSessionId(true)
          if (observedSessionId !== sessionId || !isCurrentRecording()) {
            onSessionChanged(observedSessionId, false)
            return
          }
          transport.releaseHeld(() => {
            recorder.takeFullSnapshot()
          })
        } catch (error) {
          safeReportError(config.onError, error)
        }
      },
      emit: (event) => {
        if (!active) {
          return
        }
        try {
          const userActivity = isUserActivityEvent(event)
          const observedSessionId = getSessionId(userActivity)
          if (observedSessionId !== sessionId || !isCurrentRecording()) {
            // A background mutation can be the first to see an idle session expire. The next
            // recording waits for activity, as it does when the session monitor sees the expiry.
            onSessionChanged(observedSessionId, !userActivity)
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
      // A periodic replacement anchor must not reset a longer minimum-duration gate.
      checkoutEveryNms: mode === 'buffer' ? 120_000 : Math.max(300_000, config.minSessionDurationMs),
      redactUrlPatterns: config.redactUrlPatterns,
      transformUrl: config.transformUrl,
      onError: (error) => {
        safeReportError(config.onError, error)
      },
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

    const handleError = (payload: { message: string; source?: string; stack?: string; timestamp?: number }) => {
      if (!isRuntimeActive()) {
        return
      }
      transport.releaseHeld(() => {
        recorder.takeFullSnapshot()
      })
      addCustomEvent(CustomTag.Error, payload)
      if (!isRuntimeActive()) {
        return
      }
      if (transport.getMode() === 'buffer') {
        saveSamplingMode(samplingModeStorage, sessionId, 'full')
        ignorePromise(transport.triggerFlush(), config.onError)
      }
    }
    // The browser SDK can forward an error that this runtime's own listener already added, such as
    // an error that the application reports and then rethrows.
    const capturedErrors = new WeakSet()
    const isNewError = (error: unknown): boolean => {
      if (typeof error !== 'object' || error === null) {
        return true
      }
      if (capturedErrors.has(error)) {
        return false
      }
      capturedErrors.add(error)
      return true
    }
    const captureError = (error: unknown, options?: CaptureErrorOptions) => {
      if (isNewError(error)) {
        const payload = createErrorPayload(errorMessage(error), undefined, errorStack(error))
        handleError(typeof options?.timestamp === 'number' ? { ...payload, timestamp: options.timestamp } : payload)
      }
    }
    const onWindowError = (event: Event) => {
      // Resource load failures also dispatch non-bubbling `error` events that
      // reach Window capture listeners. They are not unhandled JavaScript
      // errors and must not promote an error-sampled replay session.
      if (!(event instanceof ErrorEvent)) {
        return
      }
      if (isNewError(event.error)) {
        handleError(createErrorPayload(event.message, event.filename, errorStack(event.error)))
      }
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      captureError(event.reason)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        ignorePromise(transport.flush({ background: true }), config.onError)
      }
    }
    const onPageHide = () => {
      ignorePromise(transport.flush({ keepalive: true }), config.onError)
    }
    if (config.captureGlobalErrors) {
      window.addEventListener('error', onWindowError, true)
      cleanup.push(() => {
        window.removeEventListener('error', onWindowError, true)
      })
      window.addEventListener('unhandledrejection', onRejection, true)
      cleanup.push(() => {
        window.removeEventListener('unhandledrejection', onRejection, true)
      })
    }
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
          transformUrl: config.transformUrl,
        })
      )
    }
    if (config.captureNavigation) {
      cleanup.push(
        captureNavigation(addCustomEvent, {
          onError: config.onError,
          redactUrlPatterns: config.redactUrlPatterns,
          transformUrl: config.transformUrl,
        })
      )
    }
    transport.start()

    return {
      sessionId,
      recordingId,
      transport,
      captureError,
      deactivate: async (keepalive = false) => {
        deactivation ??= (async () => {
          // shutdown() admits the buffered tail synchronously, so the recorder
          // can stop before its bounded final upload pass finishes.
          const shutdown = transport.shutdown({ keepalive })
          active = false
          stopCleanup(cleanup)
          await shutdown
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
    getSessionAttributes: config.getSessionAttributes,
    sessionSampleRate: config.sessionSampleRate ?? DEFAULTS.sessionSampleRate,
    onErrorSampleRate: config.onErrorSampleRate ?? DEFAULTS.onErrorSampleRate,
    maskAllText: config.maskAllText ?? DEFAULTS.maskAllText,
    maskAllInputs: config.maskAllInputs ?? DEFAULTS.maskAllInputs,
    maskTextSelector: config.maskTextSelector ?? DEFAULTS.maskTextSelector,
    blockSelector: config.blockSelector ?? DEFAULTS.blockSelector,
    flushIntervalMs: config.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    maxBufferBytes: config.maxBufferBytes ?? DEFAULTS.maxBufferBytes,
    minSessionDurationMs: config.minSessionDurationMs ?? DEFAULTS.minSessionDurationMs,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs ?? DEFAULTS.sessionIdleTimeoutMs,
    maxSessionDurationMs: config.maxSessionDurationMs ?? DEFAULTS.maxSessionDurationMs,
    distinctId: config.distinctId ?? DEFAULTS.distinctId,
    getDistinctId: config.getDistinctId,
    getUser: config.getUser,
    captureConsole: config.captureConsole ?? DEFAULTS.captureConsole,
    captureNetwork: config.captureNetwork ?? DEFAULTS.captureNetwork,
    captureNavigation: config.captureNavigation ?? DEFAULTS.captureNavigation,
    captureGlobalErrors: config.captureGlobalErrors ?? DEFAULTS.captureGlobalErrors,
    ignoreUrlPatterns: config.ignoreUrlPatterns ?? [],
    redactUrlPatterns: config.redactUrlPatterns ?? [...DEFAULTS.redactUrlPatterns],
    transformUrl: reportUrlTransformErrors(config.transformUrl, config.onError),
    onError: config.onError,
    fetchImpl,
    now: config.now ?? Date.now,
    random: config.random ?? Math.random,
  }
}

/**
 * Coordinated mode needs both Web Locks and a writable `localStorage`. Without either, the replay keeps
 * the uncoordinated identity of earlier releases, where two copied documents can still collide.
 */
function resolveCoordination(now: () => number): Coordination | undefined {
  const locks = recordingLockManager()
  if (locks === undefined) {
    return undefined
  }
  const storage = writableLocalStorage()
  return storage === null ? undefined : { locks, records: new SequenceRecords(storage, now) }
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

function errorMessage(error: unknown): string {
  return coerceRejectionMessage(readErrorProperty(error, 'message') ?? error)
}

function errorStack(error: unknown): string | undefined {
  const stack = readErrorProperty(error, 'stack')
  return typeof stack === 'string' ? stack : undefined
}

// A rejected or reported value can have throwing getters, which must not stop the error event.
function readErrorProperty(error: unknown, key: 'message' | 'stack'): unknown {
  try {
    return typeof error === 'object' && error !== null && key in error ? (error as Record<string, unknown>)[key] : undefined
  } catch {
    return undefined
  }
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

// The redaction that calls a transform keeps its built-in result when the transform throws, so the
// error is only reported here. A full snapshot can call a broken transform for every URL in the
// page, so only the first error is reported.
function reportUrlTransformErrors(
  transformUrl: ((url: string) => string) | undefined,
  onError: ((error: unknown) => void) | undefined
): ((url: string) => string) | undefined {
  if (transformUrl === undefined) {
    return undefined
  }
  let reported = false
  return (url) => {
    try {
      return transformUrl(url)
    } catch (error) {
      if (!reported) {
        reported = true
        safeReportError(onError, error)
      }
      throw error
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
  // Replay custom events are not masked, and a rejected or reported object can hold credentials,
  // so only its type is recorded. The span for the same error carries the scrubbed details.
  try {
    return Object.prototype.toString.call(value)
  } catch {
    // A throwing Symbol.toStringTag getter.
    return '[object Object]'
  }
}
