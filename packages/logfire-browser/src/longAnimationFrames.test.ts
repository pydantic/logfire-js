/**
 * @vitest-environment jsdom
 */
import { diag } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { BrowserSessionManager } from './browserSession'
import { startBrowserLongAnimationFrames } from './longAnimationFrames'

interface TestSpan {
  attributes: Record<string, unknown>
  endTime?: unknown
  name: string
  startTime?: unknown
}

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new Error('storage read failed')
  }

  override setItem(_key: string, _value: string): void {
    throw new Error('storage write failed')
  }
}

class MockPerformanceObserver {
  static instances: MockPerformanceObserver[] = []
  static supportedEntryTypes: string[] = ['long-animation-frame']

  readonly disconnect = vi.fn<() => void>()
  readonly observe = vi.fn<(options: PerformanceObserverInit) => void>()
  private readonly callback: PerformanceObserverCallback
  private queuedEntries: PerformanceEntry[] = []
  readonly takeRecords = vi.fn<() => PerformanceEntry[]>(() => {
    const entries = this.queuedEntries
    this.queuedEntries = []
    return entries
  })

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback
    MockPerformanceObserver.instances.push(this)
  }

  deliver(entries: PerformanceEntry[]): void {
    this.callback(
      {
        getEntries: () => entries,
      } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver
    )
  }

  queue(entries: PerformanceEntry[]): void {
    this.queuedEntries.push(...entries)
  }
}

const originalPerformanceObserver = globalThis.PerformanceObserver

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

function createTracer(spans: TestSpan[]) {
  return {
    startSpan(name: string, options?: { startTime?: unknown }) {
      const span: TestSpan = { attributes: {}, name, startTime: options?.startTime }
      spans.push(span)
      return {
        end(endTime?: unknown) {
          span.endTime = endTime
          return undefined
        },
        setAttributes(attributes: Record<string, unknown>) {
          Object.assign(span.attributes, attributes)
          return this
        },
      }
    },
  }
}

function createSessionManager(
  storage: Storage,
  now: () => number,
  generateId: () => string = () => 'session-1',
  storageKey = 'test-browser-session'
) {
  return new BrowserSessionManager({
    generateId,
    now,
    storage,
    storageKey,
  })
}

function createFrame(
  blockingDuration: number,
  options: { duration?: number; scripts?: Record<string, unknown>[]; startTime?: number; styleAndLayoutStart?: number } = {}
): PerformanceEntry {
  const startTime = options.startTime ?? 10
  return {
    blockingDuration,
    duration: options.duration ?? blockingDuration + 50,
    entryType: 'long-animation-frame',
    name: 'long-animation-frame',
    scripts: options.scripts ?? [],
    startTime,
    styleAndLayoutStart: options.styleAndLayoutStart ?? 0,
    toJSON: () => ({}),
  } as unknown as PerformanceEntry
}

function createScript(duration: number, suffix: string): Record<string, unknown> {
  return {
    duration,
    invoker: `Element#${suffix}.onclick`,
    invokerType: 'event-listener',
    sourceFunctionName: `handler${suffix}`,
    sourceURL: `https://cdn.example.com/${suffix}.js?user=secret#call`,
  }
}

describe('browser long animation frame reporting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockPerformanceObserver.instances.length = 0
    MockPerformanceObserver.supportedEntryTypes = ['long-animation-frame']
    Object.defineProperty(globalThis, 'PerformanceObserver', {
      configurable: true,
      value: MockPerformanceObserver,
    })
    setVisibilityState('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'PerformanceObserver', {
      configurable: true,
      value: originalPerformanceObserver,
    })
  })

  it('stays inert when unsupported or sampled out', () => {
    const storage = new MemoryStorage()
    const sessionManager = createSessionManager(storage, () => 0)

    MockPerformanceObserver.supportedEntryTypes = []
    expect(
      startBrowserLongAnimationFrames({
        autoFlushOnDocumentHide: true,
        forceFlush: async () => Promise.resolve(),
        sessionManager,
        sessionSampleRate: 1,
        storage,
        tracer: createTracer([]) as never,
      })
    ).toBeUndefined()

    MockPerformanceObserver.supportedEntryTypes = ['long-animation-frame']
    expect(
      startBrowserLongAnimationFrames({
        autoFlushOnDocumentHide: true,
        forceFlush: async () => Promise.resolve(),
        sessionManager,
        sessionSampleRate: 0,
        storage,
        tracer: createTracer([]) as never,
      })
    ).toBeUndefined()
    expect(MockPerformanceObserver.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('normalizes hostile collection options to bounded defaults', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      blockingDurationThresholdMs: Number.NaN,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 2,
      storage,
      tracer: createTracer(spans) as never,
      windowDurationMs: 1,
    })
    MockPerformanceObserver.instances[0]?.deliver([createFrame(100, { startTime: 1 })])

    now = 9_999
    await vi.advanceTimersByTimeAsync(9_999)
    expect(spans).toEqual([])
    now = 10_000
    await vi.advanceTimersByTimeAsync(1)
    expect(spans.map((span) => span.name)).toEqual(['browser.long_animation_frame', 'browser.main_thread_window'])

    await handle?.shutdown()
  })

  it('reports the worst frame and an exact foreground window summary', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: true,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      timeOrigin: 1_000_000,
      tracer: createTracer(spans) as never,
    })
    const observer = MockPerformanceObserver.instances[0]
    expect(observer?.observe).toHaveBeenCalledWith({ buffered: true, type: 'long-animation-frame' })

    observer?.deliver([
      createFrame(150, {
        duration: 210,
        scripts: [createScript(20, 'small'), createScript(80, 'large')],
        startTime: 10,
        styleAndLayoutStart: 170,
      }),
    ])
    now = 60_000
    await vi.advanceTimersByTimeAsync(60_000)

    expect(spans.map((span) => span.name)).toEqual(['browser.long_animation_frame', 'browser.main_thread_window'])
    expect(spans[0]?.attributes).toEqual({
      'browser.long_animation_frame.blocking_duration': 150,
      'browser.long_animation_frame.duration': 210,
      'browser.long_animation_frame.script.duration': 80,
      'browser.long_animation_frame.script.function_name': 'handlerlarge',
      'browser.long_animation_frame.script.invoker_type': 'event-listener',
      'browser.long_animation_frame.script.source_url': 'https://cdn.example.com/large.js',
      'browser.long_animation_frame.style_and_layout_duration': 50,
      'logfire.span_type': 'log',
    })
    expect(spans[0]).toMatchObject({ endTime: 1_000_010, startTime: 1_000_010 })
    expect(spans[1]?.attributes).toMatchObject({
      'browser.main_thread_window.blocking_duration': 150,
      'browser.main_thread_window.dropped_long_animation_frame_count': 0,
      'browser.main_thread_window.foreground_duration': 60_000,
      'browser.main_thread_window.long_animation_frame_count': 1,
      'browser.main_thread_window.script.0.duration': 80,
      'browser.main_thread_window.script.0.source_url': 'https://cdn.example.com/large.js',
      'browser.main_thread_window.script.1.duration': 20,
      'logfire.span_type': 'log',
    })

    await handle?.shutdown()
  })

  it('ranks each window, persists the cap, and resets it for a rotated session', async () => {
    let now = 0
    let sessionNumber = 1
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const sessionManager = createSessionManager(
      storage,
      () => now,
      () => `session-${sessionNumber.toString()}`
    )
    const firstHandle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: true,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager,
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    const observer = MockPerformanceObserver.instances[0]
    observer?.deliver(Array.from({ length: 22 }, (_, index) => createFrame(101 + index, { startTime: index + 1 })))
    now = 60_000
    await vi.advanceTimersByTimeAsync(60_000)

    const frameSpans = spans.filter((span) => span.name === 'browser.long_animation_frame')
    expect(frameSpans).toHaveLength(20)
    expect(frameSpans.map((span) => span.attributes['browser.long_animation_frame.blocking_duration'])).toEqual(
      Array.from({ length: 20 }, (_, index) => 122 - index)
    )
    expect(spans.find((span) => span.name === 'browser.main_thread_window')?.attributes).toMatchObject({
      'browser.main_thread_window.dropped_long_animation_frame_count': 2,
      'browser.main_thread_window.long_animation_frame_count': 22,
    })

    await firstHandle?.shutdown()
    const reloadedSessionManager = createSessionManager(
      storage,
      () => now,
      () => `session-${sessionNumber.toString()}`
    )
    const reloadedHandle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: true,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: reloadedSessionManager,
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    const reloadedObserver = MockPerformanceObserver.instances[1]
    reloadedObserver?.deliver([createFrame(500, { startTime: 60_001 })])
    now = 120_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spans.filter((span) => span.name === 'browser.long_animation_frame')).toHaveLength(20)
    expect(spans.filter((span) => span.name === 'browser.main_thread_window')[1]?.attributes).toMatchObject({
      'browser.main_thread_window.dropped_long_animation_frame_count': 1,
    })

    sessionNumber = 2
    reloadedSessionManager.reset()
    MockPerformanceObserver.instances[2]?.deliver([createFrame(600, { startTime: 120_001 })])
    now = 180_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spans.filter((span) => span.name === 'browser.long_animation_frame')).toHaveLength(21)

    await reloadedHandle?.shutdown()
  })

  it('flushes positive foreground partial windows once and removes lifecycle work', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const forceFlush = vi.fn<() => Promise<void>>(async () => Promise.resolve())
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: true,
      forceFlush,
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })

    now = 25_000
    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    expect(forceFlush).toHaveBeenCalledTimes(1)

    now = 65_000
    setVisibilityState('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    now = 75_000
    window.dispatchEvent(new Event('pagehide'))
    expect(forceFlush).toHaveBeenCalledTimes(2)
    expect(
      spans
        .filter((span) => span.name === 'browser.main_thread_window')
        .map((span) => span.attributes['browser.main_thread_window.foreground_duration'])
    ).toEqual([25_000, 10_000])

    await handle?.shutdown()
    const spanCount = spans.length
    now = 90_000
    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.runAllTimersAsync()
    expect(spans).toHaveLength(spanCount)
    expect(MockPerformanceObserver.instances[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains queued observer records before closing a foreground window', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    const observer = MockPerformanceObserver.instances[0]
    observer?.queue([createFrame(150, { startTime: 1 })])

    now = 10_000
    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(observer?.takeRecords).toHaveBeenCalledTimes(1)
    expect(spans.map((span) => span.name)).toEqual(['browser.long_animation_frame', 'browser.main_thread_window'])
    expect(spans[1]?.attributes['browser.main_thread_window.long_animation_frame_count']).toBe(1)
    await handle?.shutdown()
  })

  it('opens a fresh foreground window after a back-forward cache restore', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })

    now = 10_000
    window.dispatchEvent(new Event('pagehide'))
    now = 20_000
    window.dispatchEvent(new Event('pageshow'))
    MockPerformanceObserver.instances[0]?.deliver([createFrame(150, { startTime: 20_001 })])
    now = 30_000
    window.dispatchEvent(new Event('pagehide'))

    expect(
      spans
        .filter((span) => span.name === 'browser.main_thread_window')
        .map((span) => span.attributes['browser.main_thread_window.foreground_duration'])
    ).toEqual([10_000, 10_000])
    expect(spans.filter((span) => span.name === 'browser.long_animation_frame')).toHaveLength(1)
    await handle?.shutdown()
  })

  it('ranks buffered entries separately from the foreground denominator', async () => {
    let now = 1_000
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
      windowDurationMs: 10_000,
    })
    MockPerformanceObserver.instances[0]?.deliver([createFrame(120, { startTime: 500 }), createFrame(140, { startTime: 1_001 })])
    expect(spans.map((span) => span.name)).toEqual(['browser.long_animation_frame'])

    now = 11_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(spans.map((span) => span.name)).toEqual([
      'browser.long_animation_frame',
      'browser.long_animation_frame',
      'browser.main_thread_window',
    ])
    expect(spans[2]?.attributes).toMatchObject({
      'browser.main_thread_window.blocking_duration': 140,
      'browser.main_thread_window.long_animation_frame_count': 1,
    })

    await handle?.shutdown()
  })

  it('re-evaluates deterministic fractional sampling after each session rotation', async () => {
    const storage = new MemoryStorage()
    const sessionIds = ['sampled', 'unsampled', 'sampled']
    const sessionManager = createSessionManager(
      storage,
      () => 0,
      () => sessionIds.shift() ?? 'unsampled'
    )
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      sessionManager,
      sessionSampleRate: 0.5,
      storage,
      tracer: createTracer([]) as never,
    })
    const observer = MockPerformanceObserver.instances[0]
    expect(handle).toBeDefined()

    sessionManager.reset()
    observer?.deliver([createFrame(150)])

    expect(observer?.disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    sessionManager.reset()
    expect(MockPerformanceObserver.instances).toHaveLength(2)
    MockPerformanceObserver.instances[1]?.deliver([createFrame(150)])
    await vi.advanceTimersByTimeAsync(60_000)
    await handle?.shutdown()

    const sampledOutIds = ['unsampled', 'sampled']
    const sampledOutManager = createSessionManager(
      new MemoryStorage(),
      () => 0,
      () => sampledOutIds.shift() ?? 'sampled'
    )
    const sampledOutHandle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      sessionManager: sampledOutManager,
      sessionSampleRate: 0.5,
      tracer: createTracer([]) as never,
    })
    expect(sampledOutHandle).toBeDefined()
    expect(MockPerformanceObserver.instances).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    sampledOutManager.reset()
    expect(MockPerformanceObserver.instances).toHaveLength(3)
    await sampledOutHandle?.shutdown()
  })

  it('discards a partial window when the browser session rotates', async () => {
    let now = 0
    let sessionNumber = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const sessionManager = createSessionManager(
      storage,
      () => now,
      () => `session-${(++sessionNumber).toString()}`
    )
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager,
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    const observer = MockPerformanceObserver.instances[0]
    observer?.deliver([createFrame(150, { startTime: 1 })])
    now = 30_000
    sessionManager.reset()
    now = 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spans.filter((span) => span.name === 'browser.long_animation_frame')).toEqual([])

    MockPerformanceObserver.instances[1]?.deliver([createFrame(200, { startTime: 60_001 })])
    now = 120_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spans.filter((span) => span.name === 'browser.long_animation_frame')).toHaveLength(1)
    expect(spans.find((span) => span.name === 'browser.long_animation_frame')?.attributes).toMatchObject({
      'browser.long_animation_frame.blocking_duration': 200,
    })

    await handle?.shutdown()
  })

  it('isolates persisted diagnostic caps by browser-session storage key', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const firstHandle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(
        storage,
        () => now,
        () => 'shared-session',
        'session-a'
      ),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    MockPerformanceObserver.instances[0]?.deliver(Array.from({ length: 20 }, (_, index) => createFrame(101 + index)))
    now = 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    await firstHandle?.shutdown()

    const secondHandle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(
        storage,
        () => now,
        () => 'shared-session',
        'session-b'
      ),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    MockPerformanceObserver.instances[1]?.deliver([createFrame(500, { startTime: 60_001 })])
    now = 120_000
    await vi.advanceTimersByTimeAsync(60_000)

    expect(spans.filter((span) => span.name === 'browser.long_animation_frame')).toHaveLength(21)
    expect(storage.getItem('lf_browser_loaf:session-a')).not.toBeNull()
    expect(storage.getItem('lf_browser_loaf:session-b')).not.toBeNull()
    await secondHandle?.shutdown()
  })

  it('aggregates matching scripts and exports only the top three', async () => {
    let now = 0
    const spans: TestSpan[] = []
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer(spans) as never,
    })
    MockPerformanceObserver.instances[0]?.deliver([
      createFrame(150, {
        scripts: [createScript(40, 'shared'), createScript(90, 'second'), createScript(80, 'third'), createScript(70, 'fourth')],
        startTime: 1,
      }),
      createFrame(160, { scripts: [createScript(60, 'shared')], startTime: 2 }),
    ])
    now = 60_000
    await vi.advanceTimersByTimeAsync(60_000)

    const summary = spans.find((span) => span.name === 'browser.main_thread_window')
    expect(summary?.attributes).toMatchObject({
      'browser.main_thread_window.script.0.duration': 100,
      'browser.main_thread_window.script.0.source_url': 'https://cdn.example.com/shared.js',
      'browser.main_thread_window.script.1.duration': 90,
      'browser.main_thread_window.script.1.source_url': 'https://cdn.example.com/second.js',
      'browser.main_thread_window.script.2.duration': 80,
      'browser.main_thread_window.script.2.source_url': 'https://cdn.example.com/third.js',
    })
    expect(summary?.attributes).not.toHaveProperty('browser.main_thread_window.script.3.duration')

    await handle?.shutdown()
  })

  it('skips malformed frames and contains tracer and storage failures', async () => {
    let now = 0
    const reportError = new Error('span start failed')
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    const storage = new ThrowingStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: async () => Promise.resolve(),
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: {
        startSpan() {
          throw reportError
        },
      } as never,
    })
    MockPerformanceObserver.instances[0]?.deliver([
      createFrame(Number.NaN, { startTime: 1 }),
      createFrame(-1, { startTime: 2 }),
      createFrame(150, { startTime: 3 }),
      { entryType: 'long-animation-frame', name: 'long-animation-frame', startTime: 4 } as PerformanceEntry,
    ])
    now = 60_000
    await vi.advanceTimersByTimeAsync(60_000)

    expect(diagError).toHaveBeenNthCalledWith(1, 'logfire-browser: failed to report browser.long_animation_frame', reportError)
    expect(diagError).toHaveBeenNthCalledWith(2, 'logfire-browser: failed to report browser.main_thread_window', reportError)
    expect(diagError).toHaveBeenCalledTimes(2)

    await handle?.shutdown()
  })

  it('honors document-hide auto-flush and contains flush rejection', async () => {
    let now = 0
    const flushError = new Error('flush failed')
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    const forceFlush = vi.fn<() => Promise<void>>(async () => Promise.reject(flushError))
    const storage = new MemoryStorage()
    const handle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: true,
      forceFlush,
      now: () => now,
      sessionManager: createSessionManager(storage, () => now),
      sessionSampleRate: 1,
      storage,
      tracer: createTracer([]) as never,
    })
    now = 10_000
    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => {
      expect(diagError).toHaveBeenCalledWith('logfire-browser: failed to flush long animation frame spans on document hide', flushError)
    })
    expect(forceFlush).toHaveBeenCalledTimes(1)
    await handle?.shutdown()

    setVisibilityState('visible')
    const disabledFlush = vi.fn<() => Promise<void>>(async () => Promise.resolve())
    const disabledHandle = startBrowserLongAnimationFrames({
      autoFlushOnDocumentHide: false,
      forceFlush: disabledFlush,
      now: () => now,
      sessionManager: createSessionManager(new MemoryStorage(), () => now),
      sessionSampleRate: 1,
      tracer: createTracer([]) as never,
    })
    now = 20_000
    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(disabledFlush).not.toHaveBeenCalled()
    await disabledHandle?.shutdown()
  })
})
