import type { Attributes, Tracer } from '@opentelemetry/api'
import { diag } from '@opentelemetry/api'

import type { BrowserSessionManager } from './browserSession'
import type { NormalizedScriptAttributes } from './scriptAttributes'
import { normalizeScriptEntry } from './scriptAttributes'

const DEFAULT_BLOCKING_DURATION_THRESHOLD_MS = 100
const DEFAULT_SESSION_SAMPLE_RATE = 0.1
const DEFAULT_WINDOW_DURATION_MS = 60_000
const MIN_WINDOW_DURATION_MS = 10_000
const MAX_FRAME_SPANS_PER_SESSION = 20
const MAX_WINDOW_SCRIPTS = 3
const LOGFIRE_SPAN_TYPE_KEY = 'logfire.span_type'
const STORAGE_KEY = 'lf_browser_loaf'

export interface BrowserLongAnimationFramesOptions {
  /** Minimum blockingDuration for a per-frame diagnostic. Defaults to 100 ms. */
  blockingDurationThresholdMs?: number
  /** Probability that one browser session is observed. Defaults to 0.1. */
  sessionSampleRate?: number
  /** Foreground summary and diagnostic-ranking interval. Defaults to 60 seconds. */
  windowDurationMs?: number
}

export interface BrowserLongAnimationFramesHandle {
  shutdown: () => Promise<void>
}

interface BrowserLongAnimationFramesStartOptions extends BrowserLongAnimationFramesOptions {
  autoFlushOnDocumentHide: boolean
  forceFlush: () => Promise<void>
  now?: () => number
  sessionManager: BrowserSessionManager
  storage?: Storage | null
  timeOrigin?: number
  tracer: Tracer
}

interface NormalizedFrame {
  blockingDuration: number
  duration: number
  scripts: NormalizedScriptAttributes[]
  startTime: number
  styleAndLayoutDuration: number
}

interface ScriptAggregate extends NormalizedScriptAttributes {
  firstObserved: number
}

interface WindowState {
  blockingDuration: number
  candidates: FrameCandidate[]
  frameCount: number
  scripts: Map<string, ScriptAggregate>
  startedAt: number
}

interface FrameCandidate {
  frame: NormalizedFrame
  observed: number
}

interface PersistedCapState {
  emitted: number
  sessionId: string
}

interface ResolvedOptions {
  blockingDurationThresholdMs: number
  sessionSampleRate: number
  windowDurationMs: number
}

export function startBrowserLongAnimationFrames(
  options: BrowserLongAnimationFramesStartOptions
): BrowserLongAnimationFramesHandle | undefined {
  if (!supportsLongAnimationFrames()) {
    return undefined
  }

  const resolved = resolveOptions(options)
  if (resolved.sessionSampleRate <= 0) {
    return undefined
  }
  const sessionId = options.sessionManager.getSession().id
  const collector = new LongAnimationFrameCollector(options, resolved, sessionId)
  collector.start()
  return collector.handle()
}

class LongAnimationFrameCollector {
  private active = true
  private readonly capStorageKey: string
  private capState: PersistedCapState
  private collecting = false
  private collectorStartedAt = 0
  private currentSessionId: string
  private firstDelivery = true
  private nextObserved = 0
  private observer: PerformanceObserver | undefined
  private readonly options: ResolvedOptions
  private readonly startOptions: BrowserLongAnimationFramesStartOptions
  private timer: ReturnType<typeof setTimeout> | undefined
  private unsubscribeSessionChange: (() => void) | undefined
  private window: WindowState | undefined

  constructor(startOptions: BrowserLongAnimationFramesStartOptions, options: ResolvedOptions, sessionId: string) {
    this.startOptions = startOptions
    this.options = options
    this.capStorageKey = `${STORAGE_KEY}:${startOptions.sessionManager.getStorageKey()}`
    this.currentSessionId = sessionId
    this.capState = loadCapState(this.storage(), this.capStorageKey, sessionId)
  }

  start(): void {
    const unsubscribeSessionChange = this.startOptions.sessionManager.onSessionChange(this.onSessionChange)
    this.unsubscribeSessionChange = unsubscribeSessionChange
    try {
      if (isSessionSampled(this.currentSessionId, this.options.sessionSampleRate)) {
        this.startCollection()
      }
    } catch (error) {
      unsubscribeSessionChange()
      this.unsubscribeSessionChange = undefined
      throw error
    }
  }

  private startCollection(): void {
    if (!this.active || this.collecting) {
      return
    }
    this.collectorStartedAt = this.now()
    this.firstDelivery = true
    const observer = new PerformanceObserver((list) => {
      this.onEntries(list.getEntries(), observer)
    })
    this.observer = observer
    try {
      observer.observe({ type: 'long-animation-frame', buffered: true })
      document.addEventListener('visibilitychange', this.onVisibilityChange, true)
      window.addEventListener('pagehide', this.onPageHide, true)
      window.addEventListener('pageshow', this.onPageShow, true)
      this.collecting = true
      if (isDocumentVisible()) {
        this.openWindow()
      }
    } catch (error) {
      this.stopCollection()
      throw error
    }
  }

  handle(): BrowserLongAnimationFramesHandle {
    let shutdownPromise: Promise<void> | undefined
    return {
      shutdown: async () => {
        shutdownPromise ??= this.shutdown()
        return shutdownPromise
      },
    }
  }

  private readonly onVisibilityChange = () => {
    if (!this.active || !this.collecting) {
      return
    }
    this.startOptions.sessionManager.getSession()
    if (isDocumentVisible()) {
      this.openWindow()
      return
    }
    const emitted = this.closeWindow()
    if (emitted) {
      this.flushAfterDocumentHide()
    }
  }

  private readonly onPageHide = () => {
    if (!this.active || !this.collecting) {
      return
    }
    const emitted = this.closeWindow()
    if (emitted) {
      this.flushAfterDocumentHide()
    }
  }

  private readonly onPageShow = () => {
    if (!this.active || !this.collecting) {
      return
    }
    this.startOptions.sessionManager.getSession()
    if (isDocumentVisible()) {
      this.openWindow()
    }
  }

  private readonly onSessionChange = (session: { id: string }) => {
    if (!this.active || session.id === this.currentSessionId) {
      return
    }
    this.stopCollection()
    this.currentSessionId = session.id
    this.capState = loadCapState(this.storage(), this.capStorageKey, session.id)
    if (isSessionSampled(session.id, this.options.sessionSampleRate)) {
      try {
        this.startCollection()
      } catch (error) {
        diag.error('logfire-browser: failed to restart Long Animation Frame reporting after browser session rotation', error)
      }
    }
  }

  private onEntries(entries: PerformanceEntry[], sourceObserver: PerformanceObserver): void {
    if (!this.active || !this.collecting || sourceObserver !== this.observer) {
      return
    }
    this.startOptions.sessionManager.getSession()
    if (sourceObserver !== this.observer) {
      return
    }

    const startupCandidates: FrameCandidate[] = []
    const currentWindow = this.window
    for (const entry of entries) {
      const frame = normalizeFrame(entry)
      if (frame === undefined) {
        continue
      }
      const observed = this.nextObserved++
      if (this.firstDelivery && frame.startTime < this.collectorStartedAt) {
        if (frame.blockingDuration >= this.options.blockingDurationThresholdMs) {
          startupCandidates.push({ frame, observed })
        }
        continue
      }
      if (currentWindow === undefined || frame.startTime < currentWindow.startedAt) {
        continue
      }
      currentWindow.frameCount += 1
      currentWindow.blockingDuration += frame.blockingDuration
      addScriptAggregates(currentWindow.scripts, frame.scripts, observed)
      if (frame.blockingDuration >= this.options.blockingDurationThresholdMs) {
        currentWindow.candidates.push({ frame, observed })
      }
    }
    this.firstDelivery = false
    if (startupCandidates.length > 0) {
      this.emitRankedFrames(startupCandidates)
    }
  }

  private openWindow(): void {
    if (this.window !== undefined || !this.active || !this.collecting) {
      return
    }
    this.window = {
      blockingDuration: 0,
      candidates: [],
      frameCount: 0,
      scripts: new Map(),
      startedAt: this.now(),
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.active || !isDocumentVisible()) {
        return
      }
      this.closeWindow()
      this.openWindow()
    }, this.options.windowDurationMs)
  }

  private closeWindow(): boolean {
    const currentWindow = this.window
    const observer = this.observer
    const pendingEntries = typeof observer?.takeRecords === 'function' ? observer.takeRecords() : []
    if (observer !== undefined && pendingEntries.length > 0) {
      this.onEntries(pendingEntries, observer)
    }
    if (currentWindow === undefined || !this.collecting || observer !== this.observer || currentWindow !== this.window) {
      return false
    }
    const foregroundDuration = Math.max(0, this.now() - currentWindow.startedAt)
    this.startOptions.sessionManager.getSession()
    if (currentWindow !== this.window) {
      return false
    }
    this.window = undefined
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (foregroundDuration === 0) {
      return false
    }
    const dropped = this.emitRankedFrames(currentWindow.candidates)
    this.reportSpan('browser.main_thread_window', createWindowAttributes(currentWindow, foregroundDuration, dropped))
    return true
  }

  private emitRankedFrames(candidates: FrameCandidate[]): number {
    const ranked = [...candidates].sort(
      (left, right) => right.frame.blockingDuration - left.frame.blockingDuration || left.observed - right.observed
    )
    const remaining = Math.max(0, MAX_FRAME_SPANS_PER_SESSION - this.capState.emitted)
    const emitted = ranked.slice(0, remaining)
    for (const candidate of emitted) {
      this.reportSpan('browser.long_animation_frame', createFrameAttributes(candidate.frame), this.frameTime(candidate.frame))
    }
    if (emitted.length > 0) {
      this.capState.emitted += emitted.length
      saveCapState(this.storage(), this.capStorageKey, this.capState)
    }
    return ranked.length - emitted.length
  }

  private reportSpan(name: string, attributes: Attributes, timestamp?: number): void {
    try {
      const span = this.startOptions.tracer.startSpan(name, timestamp === undefined ? undefined : { startTime: timestamp })
      try {
        span.setAttributes(attributes)
      } finally {
        span.end(timestamp)
      }
    } catch (error) {
      diag.error(`logfire-browser: failed to report ${name}`, error)
    }
  }

  private frameTime(frame: NormalizedFrame): number {
    return (this.startOptions.timeOrigin ?? performance.timeOrigin) + frame.startTime
  }

  private flushAfterDocumentHide(): void {
    if (!this.startOptions.autoFlushOnDocumentHide) {
      return
    }
    this.startOptions.forceFlush().catch((error: unknown) => {
      diag.error('logfire-browser: failed to flush long animation frame spans on document hide', error)
    })
  }

  private async shutdown(): Promise<void> {
    if (!this.active) {
      return Promise.resolve()
    }
    if (this.collecting) {
      this.closeWindow()
    }
    this.stop()
    return Promise.resolve()
  }

  private stop(): void {
    if (!this.active) {
      return
    }
    this.active = false
    this.stopCollection()
    this.unsubscribeSessionChange?.()
    this.unsubscribeSessionChange = undefined
  }

  private stopCollection(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const observer = this.observer
    if (observer !== undefined) {
      observer.disconnect()
    }
    this.observer = undefined
    this.window = undefined
    this.collecting = false
    document.removeEventListener('visibilitychange', this.onVisibilityChange, true)
    window.removeEventListener('pagehide', this.onPageHide, true)
    window.removeEventListener('pageshow', this.onPageShow, true)
  }

  private now(): number {
    return this.startOptions.now?.() ?? performance.now()
  }

  private storage(): Storage | null {
    if (this.startOptions.storage !== undefined) {
      return this.startOptions.storage
    }
    try {
      return globalThis.sessionStorage
    } catch {
      return null
    }
  }
}

function createFrameAttributes(frame: NormalizedFrame): Attributes {
  const attributes: Attributes = {
    [LOGFIRE_SPAN_TYPE_KEY]: 'log',
    'browser.long_animation_frame.blocking_duration': frame.blockingDuration,
    'browser.long_animation_frame.duration': frame.duration,
    'browser.long_animation_frame.style_and_layout_duration': frame.styleAndLayoutDuration,
  }
  const topScript = [...frame.scripts].sort((left, right) => right.duration - left.duration)[0]
  if (topScript !== undefined) {
    setScriptAttributes(attributes, 'browser.long_animation_frame.script', topScript)
  }
  return attributes
}

function createWindowAttributes(windowState: WindowState, foregroundDuration: number, dropped: number): Attributes {
  const attributes: Attributes = {
    [LOGFIRE_SPAN_TYPE_KEY]: 'log',
    'browser.main_thread_window.blocking_duration': windowState.blockingDuration,
    'browser.main_thread_window.dropped_long_animation_frame_count': dropped,
    'browser.main_thread_window.foreground_duration': foregroundDuration,
    'browser.main_thread_window.long_animation_frame_count': windowState.frameCount,
  }
  const scripts = [...windowState.scripts.values()]
    .sort((left, right) => right.duration - left.duration || left.firstObserved - right.firstObserved)
    .slice(0, MAX_WINDOW_SCRIPTS)
  scripts.forEach((script, index) => {
    setScriptAttributes(attributes, `browser.main_thread_window.script.${index.toString()}`, script)
  })
  return attributes
}

function setScriptAttributes(attributes: Attributes, prefix: string, script: NormalizedScriptAttributes): void {
  attributes[`${prefix}.duration`] = script.duration
  if (script.sourceUrl !== undefined) {
    attributes[`${prefix}.source_url`] = script.sourceUrl
  }
  if (script.functionName !== undefined) {
    attributes[`${prefix}.function_name`] = script.functionName
  }
  if (script.invokerType !== undefined) {
    attributes[`${prefix}.invoker_type`] = script.invokerType
  }
}

function normalizeFrame(value: unknown): NormalizedFrame | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const frame = value as {
    blockingDuration?: unknown
    duration?: unknown
    scripts?: unknown
    startTime?: unknown
    styleAndLayoutStart?: unknown
  }
  if (!isFiniteNonNegative(frame.blockingDuration) || !isFiniteNonNegative(frame.duration) || !isFiniteNonNegative(frame.startTime)) {
    return undefined
  }
  const frameEnd = frame.startTime + frame.duration
  const styleAndLayoutDuration =
    isFiniteNonNegative(frame.styleAndLayoutStart) && frame.styleAndLayoutStart > 0 ? Math.max(0, frameEnd - frame.styleAndLayoutStart) : 0
  const scripts = Array.isArray(frame.scripts)
    ? frame.scripts.map((script) => normalizeScriptEntry(script)).filter((script) => script !== undefined)
    : []
  return {
    blockingDuration: frame.blockingDuration,
    duration: frame.duration,
    scripts,
    startTime: frame.startTime,
    styleAndLayoutDuration,
  }
}

function addScriptAggregates(aggregates: Map<string, ScriptAggregate>, scripts: NormalizedScriptAttributes[], observed: number): void {
  for (const script of scripts) {
    const key = `${script.sourceUrl ?? ''}\u0000${script.functionName ?? ''}\u0000${script.invokerType ?? ''}`
    const current = aggregates.get(key)
    if (current === undefined) {
      aggregates.set(key, { ...script, firstObserved: observed })
    } else {
      current.duration += script.duration
    }
  }
}

function resolveOptions(options: BrowserLongAnimationFramesOptions): ResolvedOptions {
  const sampleRate = options.sessionSampleRate ?? DEFAULT_SESSION_SAMPLE_RATE
  const threshold = options.blockingDurationThresholdMs ?? DEFAULT_BLOCKING_DURATION_THRESHOLD_MS
  const windowDuration = options.windowDurationMs ?? DEFAULT_WINDOW_DURATION_MS
  return {
    blockingDurationThresholdMs: Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_BLOCKING_DURATION_THRESHOLD_MS,
    sessionSampleRate: Number.isFinite(sampleRate) ? Math.min(1, Math.max(0, sampleRate)) : 0,
    windowDurationMs:
      Number.isFinite(windowDuration) && windowDuration > 0 ? Math.max(MIN_WINDOW_DURATION_MS, windowDuration) : DEFAULT_WINDOW_DURATION_MS,
  }
}

function supportsLongAnimationFrames(): boolean {
  try {
    return typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
  } catch {
    return false
  }
}

function isSessionSampled(sessionId: string, rate: number): boolean {
  if (rate <= 0) {
    return false
  }
  if (rate >= 1) {
    return true
  }
  let hash = 2_166_136_261
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) / 4_294_967_296 < rate
}

function loadCapState(storage: Storage | null, storageKey: string, sessionId: string): PersistedCapState {
  if (storage !== null) {
    try {
      const raw = storage.getItem(storageKey)
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)
        if (isPersistedCapState(parsed) && parsed.sessionId === sessionId) {
          return parsed
        }
      }
    } catch {
      // Session-level collection bounds are best-effort when storage is unavailable.
    }
  }
  return { emitted: 0, sessionId }
}

function saveCapState(storage: Storage | null, storageKey: string, state: PersistedCapState): void {
  if (storage === null) {
    return
  }
  try {
    storage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // Session-level collection bounds are best-effort when storage is unavailable.
  }
}

function isPersistedCapState(value: unknown): value is PersistedCapState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const state = value as { emitted?: unknown; sessionId?: unknown }
  return (
    typeof state.sessionId === 'string' &&
    typeof state.emitted === 'number' &&
    Number.isInteger(state.emitted) &&
    state.emitted >= 0 &&
    state.emitted <= MAX_FRAME_SPANS_PER_SESSION
  )
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible'
}
