/**
 * @vitest-environment jsdom
 */
import { diag } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { startSessionReplay } from '@pydantic/logfire-session-replay'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { clearConfiguredBrowserSessionForTests } from './browserSession'
import { configure, startSpan } from './index'

const originalFetch = globalThis.fetch

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
  clearConfiguredBrowserSessionForTests()
  sessionStorage.clear()
  optionalFeatureMocks.reset()
  vi.restoreAllMocks()
})

describe('public browser configure startup ordering', () => {
  it.each(['replay-first', 'auto-first'] as const)(
    'suppresses every SDK endpoint with installed auto-instrumentation when %s',
    async (order) => {
      const rawFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response('{}', { headers: { 'content-length': '2' }, status: 200 }))
      )
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: rawFetch, writable: true })
      const exporter = new InMemorySpanExporter()
      const events: string[] = []
      let replayRuntime: ReturnType<typeof startSessionReplay> | undefined
      let releaseReplayModule: (() => void) | undefined
      const replayModuleGate = new Promise<void>((resolve) => {
        releaseReplayModule = resolve
      })
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
          load: async () => {
            if (order === 'auto-first') {
              await replayModuleGate
            }
            return replayModule
          },
          replayUrl: '/client-replay',
          sessionSampleRate: 1,
        },
        spanProcessors: [new SimpleSpanProcessor(exporter)],
        traceUrl: '/client-traces',
      })

      try {
        if (order === 'auto-first') {
          await waitUntil(() => globalThis.fetch !== rawFetch)
          events.push('auto-ready')
          releaseReplayModule?.()
          await waitUntil(() => replayRuntime !== undefined)
        } else {
          await waitUntil(() => replayRuntime !== undefined)
          const replayFetch = globalThis.fetch
          await waitUntil(() => globalThis.fetch !== replayFetch)
          events.push('auto-ready')
        }

        expect(events).toEqual(order === 'auto-first' ? ['auto-ready', 'replay-ready'] : ['replay-ready', 'auto-ready'])
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
    }
  )

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

  it('exports Web Vitals spans when browser metrics startup fails', async () => {
    const exporter = new InMemorySpanExporter()
    const diagWarn = vi.spyOn(diag, 'warn').mockImplementation(() => undefined)
    optionalFeatureMocks.metricsStartupError = new Error('metrics startup failed')
    const cleanup = configure({
      metrics: { metricUrl: '/client-metrics' },
      rum: { webVitals: { metrics: true } },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      await waitUntil(() => optionalFeatureMocks.hasWebVitalCallback)
      await delay(0)
      optionalFeatureMocks.reportFcp()
      const span = exporter.getFinishedSpans().find(({ name }) => name === 'web_vital.fcp')
      expect(span?.attributes['logfire.span_type']).toBe('log')
      expect(diagWarn).toHaveBeenCalledWith(
        'logfire-browser: browser metrics did not start; continuing Web Vitals with span reporting only'
      )
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
