/**
 * @vitest-environment jsdom
 */
/* eslint-disable import/first */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const webVitalsMock = vi.hoisted(() => {
  let callback: ((metric: unknown) => void) | undefined
  return {
    get ready() {
      return callback !== undefined
    },
    register(nextCallback: (metric: unknown) => void) {
      callback = nextCallback
    },
    reportFcp() {
      callback?.({
        attribution: { firstByteToFCP: 5, loadState: 'complete', timeToFirstByte: 10 },
        delta: 15,
        entries: [],
        id: 'credential-failure-fcp',
        name: 'FCP',
        navigationType: 'navigate',
        rating: 'good',
        value: 15,
      })
    },
  }
})

vi.mock('web-vitals/attribution', () => ({
  onCLS: (callback: (metric: unknown) => void) => {
    webVitalsMock.register(callback)
  },
  onFCP: (callback: (metric: unknown) => void) => {
    webVitalsMock.register(callback)
  },
  onINP: (callback: (metric: unknown) => void) => {
    webVitalsMock.register(callback)
  },
  onLCP: (callback: (metric: unknown) => void) => {
    webVitalsMock.register(callback)
  },
  onTTFB: (callback: (metric: unknown) => void) => {
    webVitalsMock.register(callback)
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

import { clearConfiguredBrowserSessionForTests } from './browserSession'
import { configure } from './index'

afterEach(() => {
  clearConfiguredBrowserSessionForTests()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('public optional-feature credential containment', () => {
  it('keeps Web Vitals spans while synchronous and asynchronous metric headers fail closed', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Promise.resolve(new Response(null, { status: 202 })))
    vi.stubGlobal('fetch', fetchImpl)

    await runHeaderFailureCase(() => {
      throw new Error('synchronous metric headers unavailable')
    })
    await runHeaderFailureCase(async () => Promise.reject(new Error('asynchronous metric headers unavailable')))

    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

async function runHeaderFailureCase(metricExporterHeaders: () => Record<string, string> | Promise<Record<string, string>>) {
  const exporter = new InMemorySpanExporter()
  const cleanup = configure({
    metrics: {
      metricExporterHeaders,
      metricReaderConfig: { exportIntervalMillis: 60_000, exportTimeoutMillis: 1_000 },
      metricUrl: '/client-metrics',
    },
    rum: { webVitals: { metrics: true } },
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    traceUrl: '/client-traces',
  })

  try {
    await waitUntil(() => webVitalsMock.ready)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    webVitalsMock.reportFcp()
    const span = exporter.getFinishedSpans().find(({ name }) => name === 'web_vital.fcp')
    expect(span?.attributes['logfire.span_type']).toBe('log')
  } finally {
    await cleanup()
  }
}

async function waitUntil(predicate: () => boolean, attempts = 100): Promise<void> {
  if (predicate()) {
    return
  }
  if (attempts === 0) {
    throw new Error('timed out waiting for Web Vitals callback')
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  return waitUntil(predicate, attempts - 1)
}
