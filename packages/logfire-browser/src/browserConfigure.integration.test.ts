/**
 * @vitest-environment jsdom
 */
import { gunzipSync } from 'node:zlib'

import { diag } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { CustomTag, startSessionReplay } from '@pydantic/logfire-session-replay'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { clearConfiguredBrowserSessionForTests } from './browserSession'
import { configure, reportError, startSpan } from './index'

const originalFetch = globalThis.fetch
const originalPerformanceObserver = globalThis.PerformanceObserver

class MockPerformanceObserver {
  static instances: MockPerformanceObserver[] = []
  static supportedEntryTypes = ['long-animation-frame']

  private readonly callback: PerformanceObserverCallback

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback
    MockPerformanceObserver.instances.push(this)
  }

  disconnect(): void {
    return undefined
  }

  observe(_options: PerformanceObserverInit): void {
    return undefined
  }

  deliver(entries: PerformanceEntry[]): void {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
  }
}

const optionalFeatureMocks = vi.hoisted(() => {
  let metricsStartupError: Error | undefined
  let webVitalCallback: ((metric: unknown) => void) | undefined
  return {
    get metricsStartupError() {
      return metricsStartupError
    },
    get hasWebVitalCallback() {
      return webVitalCallback !== undefined
    },
    set metricsStartupError(error: Error | undefined) {
      metricsStartupError = error
    },
    registerWebVital(callback: (metric: unknown) => void) {
      webVitalCallback = callback
    },
    reset() {
      metricsStartupError = undefined
    },
    reportFcp() {
      webVitalCallback?.({
        attribution: { firstByteToFCP: 5, loadState: 'complete', timeToFirstByte: 10 },
        delta: 15,
        entries: [],
        id: 'integration-fcp',
        name: 'FCP',
        navigationType: 'navigate',
        rating: 'good',
        value: 15,
      })
    },
  }
})

vi.mock('./browserMetrics', () => ({
  startBrowserMetrics: async () => {
    if (optionalFeatureMocks.metricsStartupError !== undefined) {
      throw optionalFeatureMocks.metricsStartupError
    }
    return Promise.resolve({
      createWebVitalsMetricRecorder: () => ({ record: () => undefined, shutdown: () => undefined }),
      forceFlush: async () => Promise.resolve(),
      shutdown: async () => Promise.resolve(),
    })
  },
}))

vi.mock('web-vitals/attribution', () => ({
  onCLS: (callback: (metric: unknown) => void) => {
    optionalFeatureMocks.registerWebVital(callback)
  },
  onFCP: (callback: (metric: unknown) => void) => {
    optionalFeatureMocks.registerWebVital(callback)
  },
  onINP: (callback: (metric: unknown) => void) => {
    optionalFeatureMocks.registerWebVital(callback)
  },
  onLCP: (callback: (metric: unknown) => void) => {
    optionalFeatureMocks.registerWebVital(callback)
  },
  onTTFB: (callback: (metric: unknown) => void) => {
    optionalFeatureMocks.registerWebVital(callback)
  },
}))

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
      resultCallback({ code: 0 })
    }

    async shutdown(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch, writable: true })
  Object.defineProperty(globalThis, 'PerformanceObserver', {
    configurable: true,
    value: originalPerformanceObserver,
  })
  MockPerformanceObserver.instances.length = 0
  clearConfiguredBrowserSessionForTests()
  sessionStorage.clear()
  optionalFeatureMocks.reset()
  vi.restoreAllMocks()
})

describe('public browser configure startup ordering', () => {
  it('installs auto-instrumentation before configure returns and suppresses every SDK endpoint', async () => {
    const rawFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('{}', { headers: { 'content-length': '2' }, status: 200 }))
    )
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: rawFetch, writable: true })
    const exporter = new InMemorySpanExporter()
    const events: string[] = []
    let replayRuntime: ReturnType<typeof startSessionReplay> | undefined
    const replayModule = {
      startSessionReplay(config: Parameters<typeof startSessionReplay>[0]) {
        replayRuntime = startSessionReplay(config)
        events.push('replay-ready')
        return replayRuntime
      },
    }

    const cleanup = configure({
      autoInstrumentations: {
        '@opentelemetry/instrumentation-document-load': { enabled: false },
        '@opentelemetry/instrumentation-fetch': { enabled: true },
        '@opentelemetry/instrumentation-user-interaction': { enabled: false },
        '@opentelemetry/instrumentation-xml-http-request': { enabled: false },
      },
      metrics: {
        metricReaderConfig: { exportIntervalMillis: 60_000, exportTimeoutMillis: 1_000 },
        metricUrl: '/client-metrics',
      },
      sessionReplay: {
        captureConsole: false,
        captureNavigation: false,
        captureNetwork: true,
        flushIntervalMs: 60_000,
        minSessionDurationMs: 0,
        load: () => replayModule,
        replayUrl: '/client-replay',
        sessionSampleRate: 1,
      },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      expect(globalThis.fetch).not.toBe(rawFetch)
      events.push('auto-ready')
      await waitUntil(() => replayRuntime !== undefined)

      expect(events).toEqual(['auto-ready', 'replay-ready'])
      await globalThis.fetch('/api/application')
      const exporterBypass = Reflect.get(globalThis.fetch, '__original') as typeof fetch
      await exporterBypass('/client-traces')
      await globalThis.fetch('/client-metrics')
      await replayRuntime?.flush()
      await delay(350)

      const spans = exporter.getFinishedSpans()
      expect(spans).toHaveLength(1)
      expect(JSON.stringify(spans[0]?.attributes)).toContain('/api/application')
      for (const endpoint of ['client-traces', 'client-metrics', 'client-replay']) {
        expect(spans.some((span) => JSON.stringify(span.attributes).includes(endpoint))).toBe(false)
      }
      const issuedUrls = rawFetch.mock.calls.map(([input]) => fetchInputUrl(input))
      expect(issuedUrls).toEqual(expect.arrayContaining(['http://localhost:3000/api/application', '/client-traces', '/client-metrics']))
      expect(issuedUrls.some((url) => /^\/client-replay\/[^/?#]+\?seq=0$/u.test(url))).toBe(true)
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: rawFetch, writable: true })
      await cleanup()
    }
  })

  it.each(['handled', 'uncaught'] as const)('promotes an error-buffered replay once for a %s error', async (kind) => {
    const replayFetch = vi.fn<typeof fetch>(async () => Promise.resolve(new Response(null, { status: 202 })))
    let replayRuntime: ReturnType<typeof startSessionReplay> | undefined
    const replayModule = {
      startSessionReplay(config: Parameters<typeof startSessionReplay>[0]) {
        replayRuntime = startSessionReplay(config)
        return replayRuntime
      },
    }
    const cleanup = configure({
      sessionReplay: {
        captureConsole: false,
        captureNavigation: false,
        captureNetwork: false,
        fetchImpl: replayFetch,
        flushIntervalMs: 60_000,
        load: () => replayModule,
        minSessionDurationMs: 0,
        onErrorSampleRate: 1,
        replayUrl: '/client-replay',
        sessionSampleRate: 0,
      },
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
      traceUrl: '/client-traces',
    })

    try {
      await waitUntil(() => replayRuntime !== undefined)
      expect(replayRuntime?.mode).toBe('buffer')
      const error = new Error(kind)
      if (kind === 'handled') {
        reportError('Handled error', error)
      } else {
        window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
      }
      // The browser SDK reports an uncaught error after the dispatch, so the replay's own listener must not promote it first.
      const modeAfterDispatch = replayRuntime?.mode
      await delay(0)

      expect(modeAfterDispatch).toBe(kind === 'handled' ? 'full' : 'buffer')
      expect(replayRuntime?.mode).toBe('full')
    } finally {
      await cleanup()
    }
    // Shutdown uploads the promoted buffer.
    const events = replayFetch.mock.calls.flatMap(([, init]) => decodeReplayEvents(init?.body))
    const errorEvents = events.filter((event) => event.type === 5 && event.data?.tag === CustomTag.Error)
    expect(errorEvents.map((event) => event.data?.payload?.message)).toEqual([kind])
  })

  it('keeps real span creation safe when the lazy replay runtime getters throw', async () => {
    const replayError = new Error('replay reporter failed')
    const cleanup = configure({
      sessionReplay: {
        captureConsole: false,
        captureNavigation: false,
        captureNetwork: false,
        load: () => ({
          startSessionReplay: () => ({
            get mode(): 'full' | 'buffer' | 'off' {
              throw new Error('mode unavailable')
            },
            get recording(): boolean {
              throw new Error('recording unavailable')
            },
            flush: async () => Promise.reject(new Error('flush unavailable')),
            getSessionId: () => 'browser-session',
            stop: async () => Promise.reject(new Error('stop unavailable')),
          }),
        }),
        onError: () => Promise.reject(replayError) as unknown as void,
        replayUrl: '/client-replay',
      },
      traceUrl: '/client-traces',
    })

    try {
      await delay(0)
      expect(() => startSpan('hostile-replay')).not.toThrow()
    } finally {
      await cleanup()
    }
  })

  it('attaches the current public user to each span without rotating the session', async () => {
    let user: { id: string; name?: string; email?: string } | undefined
    const exporter = new InMemorySpanExporter()
    const cleanup = configure({
      rum: {
        session: {
          getRouteName: () => '/account',
          getSessionAttributes: () => ({ account_tier: 'pro' }),
          getUser: () => user,
        },
      },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      startSpan('anonymous').end()
      user = { email: 'alice@example.com', id: 'user-a', name: 'Alice' }
      startSpan('identified').end()
      user = { id: 'user-b' }
      startSpan('switched').end()
      user = undefined
      startSpan('logged-out').end()

      const spans = Object.fromEntries(exporter.getFinishedSpans().map((span) => [span.name, span]))
      const sessionId = spans['anonymous']?.attributes['session.id']
      expect(sessionId).toBeTypeOf('string')
      expect(spans['anonymous']?.attributes).not.toHaveProperty('user.id')
      expect(spans['identified']?.attributes).toMatchObject({
        'logfire.page.route': '/account',
        'logfire.session.account_tier': 'pro',
        'session.id': sessionId,
        'user.email': 'alice@example.com',
        'user.id': 'user-a',
        'user.name': 'Alice',
      })
      expect(spans['switched']?.attributes).toMatchObject({ 'session.id': sessionId, 'user.id': 'user-b' })
      expect(spans['switched']?.attributes).not.toHaveProperty('user.name')
      expect(spans['logged-out']?.attributes['session.id']).toBe(sessionId)
      expect(spans['logged-out']?.attributes).not.toHaveProperty('user.id')
      expect(sessionStorage.getItem('lf_browser_session')).not.toContain('user-')
    } finally {
      await cleanup()
    }
  })

  it('exports Web Vitals spans when browser metrics startup fails', async () => {
    const exporter = new InMemorySpanExporter()
    const diagWarn = vi.spyOn(diag, 'warn').mockImplementation(() => undefined)
    optionalFeatureMocks.metricsStartupError = new Error('metrics startup failed')
    const cleanup = configure({
      metrics: { metricUrl: '/client-metrics' },
      rum: {
        session: {
          getRouteName: () => '/integration',
          getSessionAttributes: () => ({ account_tier: 'pro' }),
          getUser: () => ({ id: 'user-1' }),
        },
        webVitals: { metrics: true },
      },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      await waitUntil(() => optionalFeatureMocks.hasWebVitalCallback)
      await delay(0)
      optionalFeatureMocks.reportFcp()
      const span = exporter.getFinishedSpans().find(({ name }) => name === 'web_vital.fcp')
      expect(span?.attributes['logfire.span_type']).toBe('log')
      expect(span?.attributes['logfire.page.route']).toBe('/integration')
      expect(span?.attributes['logfire.session.account_tier']).toBe('pro')
      expect(span?.attributes['user.id']).toBe('user-1')
      expect(diagWarn).toHaveBeenCalledWith(
        'logfire-browser: browser metrics did not start; continuing Web Vitals with span reporting only'
      )
    } finally {
      await cleanup()
    }
  })

  it('exports ranked Long Animation Frame spans through browser session context', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    Object.defineProperty(globalThis, 'PerformanceObserver', {
      configurable: true,
      value: MockPerformanceObserver,
    })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const exporter = new InMemorySpanExporter()
    const cleanup = configure({
      rum: {
        longAnimationFrames: { sessionSampleRate: 1 },
        session: {
          getRouteName: () => '/integration',
          getSessionAttributes: () => ({ account_tier: 'pro' }),
        },
      },
      serviceVersion: '2026.09.03',
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      MockPerformanceObserver.instances[0]?.deliver([
        {
          blockingDuration: 150,
          duration: 210,
          entryType: 'long-animation-frame',
          name: 'long-animation-frame',
          scripts: [
            {
              duration: 80,
              invokerType: 'event-listener',
              sourceFunctionName: 'renderChart',
              sourceURL: 'https://cdn.example.com/chart.js?user=secret#render',
            },
          ],
          startTime: 10,
          styleAndLayoutStart: 170,
          toJSON: () => ({}),
        } as unknown as PerformanceEntry,
      ])
      now = 25_000
      window.dispatchEvent(new Event('pagehide'))
      await delay(0)

      const frame = exporter.getFinishedSpans().find(({ name }) => name === 'browser.long_animation_frame')
      const summary = exporter.getFinishedSpans().find(({ name }) => name === 'browser.main_thread_window')
      expect(frame?.attributes).toMatchObject({
        'browser.long_animation_frame.blocking_duration': 150,
        'browser.long_animation_frame.script.source_url': 'https://cdn.example.com/chart.js',
        'logfire.page.route': '/integration',
        'logfire.session.account_tier': 'pro',
        'logfire.span_type': 'log',
      })
      expect(frame?.attributes['session.id']).toBeTypeOf('string')
      expect(frame?.resource.attributes['service.version']).toBe('2026.09.03')
      expect(summary?.attributes).toMatchObject({
        'browser.main_thread_window.blocking_duration': 150,
        'browser.main_thread_window.foreground_duration': 25_000,
        'browser.main_thread_window.long_animation_frame_count': 1,
        'logfire.page.route': '/integration',
        'logfire.session.account_tier': 'pro',
      })
    } finally {
      await cleanup()
    }
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  return waitUntilDeadline(predicate, Date.now() + 5_000)
}

async function waitUntilDeadline(predicate: () => boolean, deadline: number): Promise<void> {
  if (predicate()) {
    return
  }
  if (Date.now() >= deadline) {
    throw new Error('timed out waiting for browser configure startup order')
  }
  await delay(0)
  return waitUntilDeadline(predicate, deadline)
}

interface ReplayEvent {
  data?: { payload?: { message?: string }; tag?: string }
  type: number
}

function decodeReplayEvents(body: BodyInit | null | undefined): ReplayEvent[] {
  const envelope = JSON.parse(gunzipSync(body as Uint8Array).toString('utf8')) as { events: ReplayEvent[] }
  return envelope.events
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}
