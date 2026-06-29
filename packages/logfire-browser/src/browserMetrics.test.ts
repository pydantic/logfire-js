/* eslint-disable import/first */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

type WebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'

interface MockHistogramRecord {
  attributes: Record<string, unknown>
  value: number
}

const mocks = vi.hoisted(() => {
  const exporters: MockOTLPMetricExporter[] = []
  const histograms: MockHistogram[] = []
  const meterNames: string[] = []
  const providers: MockMeterProvider[] = []
  const readers: MockPeriodicExportingMetricReader[] = []

  class MockOTLPMetricExporter {
    options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
      exporters.push(this)
    }
  }

  class MockPeriodicExportingMetricReader {
    options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
      readers.push(this)
    }
  }

  class MockHistogram {
    name: string
    options: Record<string, unknown>
    records: MockHistogramRecord[] = []

    constructor(name: string, options: Record<string, unknown>) {
      this.name = name
      this.options = options
      histograms.push(this)
    }

    record(value: number, attributes: Record<string, unknown>): void {
      this.records.push({ attributes, value })
    }
  }

  class MockMeter {
    createHistogram(name: string, options: Record<string, unknown>): MockHistogram {
      return new MockHistogram(name, options)
    }
  }

  class MockMeterProvider {
    forceFlushCalls = 0
    getMeterCalls = 0
    options: Record<string, unknown>
    shutdownCalls = 0

    constructor(options: Record<string, unknown>) {
      this.options = options
      providers.push(this)
    }

    async forceFlush(): Promise<void> {
      this.forceFlushCalls++
      return Promise.resolve()
    }

    getMeter(name: string): MockMeter {
      this.getMeterCalls++
      meterNames.push(name)
      return new MockMeter()
    }

    async shutdown(): Promise<void> {
      this.shutdownCalls++
      return Promise.resolve()
    }
  }

  return {
    MockMeterProvider,
    MockOTLPMetricExporter,
    MockPeriodicExportingMetricReader,
    exporters,
    histograms,
    meterNames,
    providers,
    readers,
    reset() {
      exporters.length = 0
      histograms.length = 0
      meterNames.length = 0
      providers.length = 0
      readers.length = 0
    },
  }
})

vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: mocks.MockOTLPMetricExporter,
}))

vi.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: mocks.MockMeterProvider,
  PeriodicExportingMetricReader: mocks.MockPeriodicExportingMetricReader,
}))

import type { MetricWithAttribution } from 'web-vitals/attribution'

import { startBrowserMetrics } from './browserMetrics'

const expectedInstruments: Record<WebVitalName, { boundaries: number[]; name: string; unit: string }> = {
  CLS: {
    boundaries: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
    name: 'logfire.browser.web_vital.cls',
    unit: '1',
  },
  FCP: {
    boundaries: [500, 1000, 1500, 1800, 2500, 3000, 4000, 6000],
    name: 'logfire.browser.web_vital.fcp',
    unit: 'ms',
  },
  INP: {
    boundaries: [50, 100, 150, 200, 300, 500, 800, 1000, 2000],
    name: 'logfire.browser.web_vital.inp',
    unit: 'ms',
  },
  LCP: {
    boundaries: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 8000, 10000],
    name: 'logfire.browser.web_vital.lcp',
    unit: 'ms',
  },
  TTFB: {
    boundaries: [100, 300, 500, 800, 1200, 1800, 2500, 4000],
    name: 'logfire.browser.web_vital.ttfb',
    unit: 'ms',
  },
}

function createMetric(name: WebVitalName, value: number, rating = 'good'): MetricWithAttribution {
  return {
    attribution: {},
    delta: value,
    entries: [],
    id: `${name.toLowerCase()}-1`,
    name,
    navigationType: 'navigate',
    rating,
    value,
  } as unknown as MetricWithAttribution
}

function getHistogram(name: string) {
  const histogram = mocks.histograms.find((histogram) => histogram.name === name)
  expect(histogram).toBeDefined()
  if (histogram === undefined) {
    throw new Error(`expected histogram ${name}`)
  }
  return histogram
}

describe('browser metrics runtime', () => {
  beforeEach(() => {
    mocks.reset()
  })

  it('creates an OTLP metrics exporter, reader, and local meter provider', async () => {
    const additionalReader = {
      forceFlush: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
      shutdown: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
    }
    const metricExporterHeaders = vi.fn<() => Record<string, string>>(() => ({ authorization: 'test-token' }))
    await startBrowserMetrics(
      {
        metricExporterConfig: { timeoutMillis: 12_000 },
        metricExporterHeaders,
        metricReaderConfig: { exportIntervalMillis: 5_000 },
        metricReaders: [additionalReader as never],
        metricUrl: 'https://example.com/v1/metrics',
      },
      { attributes: { 'service.name': 'browser-test' } } as never
    )

    expect(mocks.exporters).toHaveLength(1)
    expect(mocks.exporters[0]?.options).toMatchObject({
      timeoutMillis: 12_000,
      url: 'https://example.com/v1/metrics',
    })
    await expect((mocks.exporters[0]?.options['headers'] as (() => Promise<Record<string, string>>) | undefined)?.()).resolves.toEqual({
      authorization: 'test-token',
    })
    expect(mocks.readers[0]?.options).toMatchObject({
      exportIntervalMillis: 5_000,
      exportTimeoutMillis: 10_000,
    })
    expect(mocks.readers[0]?.options['exporter']).toBe(mocks.exporters[0])
    expect(mocks.providers[0]?.options).toMatchObject({
      resource: { attributes: { 'service.name': 'browser-test' } },
    })
    const provider = mocks.providers[0]
    expect(provider).toBeDefined()
    if (provider === undefined) {
      throw new Error('expected meter provider')
    }
    expect(provider.options['readers'] as unknown[]).toEqual([mocks.readers[0], additionalReader])
  })

  it('creates one histogram per Web Vital with stable names, units, and buckets', async () => {
    await startBrowserMetrics({ metricUrl: '/v1/metrics/browser' }, { attributes: {} } as never)

    expect(mocks.meterNames).toEqual(['logfire-browser-web-vitals'])
    for (const expectedInstrument of Object.values(expectedInstruments)) {
      const histogram = getHistogram(expectedInstrument.name)
      expect(histogram.options).toMatchObject({
        advice: { explicitBucketBoundaries: expectedInstrument.boundaries },
        unit: expectedInstrument.unit,
      })
    }
  })

  it('records Web Vitals into the matching histograms', async () => {
    const runtime = await startBrowserMetrics({ metricUrl: '/v1/metrics/browser' }, { attributes: {} } as never)
    const recorder = runtime.createWebVitalsMetricRecorder()

    recorder.record(createMetric('LCP', 2500))
    recorder.record(createMetric('INP', 180))
    recorder.record(createMetric('CLS', 0.08))
    recorder.record(createMetric('FCP', 1200))
    recorder.record(createMetric('TTFB', 300))

    expect(getHistogram(expectedInstruments.LCP.name).records[0]?.value).toBe(2500)
    expect(getHistogram(expectedInstruments.INP.name).records[0]?.value).toBe(180)
    expect(getHistogram(expectedInstruments.CLS.name).records[0]?.value).toBe(0.08)
    expect(getHistogram(expectedInstruments.FCP.name).records[0]?.value).toBe(1200)
    expect(getHistogram(expectedInstruments.TTFB.name).records[0]?.value).toBe(300)
  })

  it('keeps Web Vital metric attributes low-cardinality', async () => {
    const runtime = await startBrowserMetrics({ metricUrl: '/v1/metrics/browser' }, { attributes: {} } as never)
    const recorder = runtime.createWebVitalsMetricRecorder({
      attributes: () =>
        ({
          'app.route': '/products/:id',
          'web_vital.id': 'custom-id',
          'web_vital.lcp.target': '#hero img',
          'web_vital.value': 999,
        }) as never,
      defaultAttributes: () =>
        ({
          'browser.session.id': 'browser-session-1',
          'session.id': 'session-1',
          'url.full': 'https://example.com/products/123?token=secret',
          'url.path': '/products/:id',
          'web_vital.delta': 12,
          ignored: { nested: true },
        }) as never,
    })

    recorder.record(createMetric('LCP', 2400, 'needs-improvement'))

    expect(getHistogram(expectedInstruments.LCP.name).records[0]?.attributes).toEqual({
      'app.route': '/products/:id',
      'url.path': '/products/:id',
      'web_vital.name': 'LCP',
      'web_vital.rating': 'needs-improvement',
    })
  })

  it('stops recording after the recorder is shut down', async () => {
    const runtime = await startBrowserMetrics({ metricUrl: '/v1/metrics/browser' }, { attributes: {} } as never)
    const recorder = runtime.createWebVitalsMetricRecorder()

    recorder.record(createMetric('FCP', 1000))
    recorder.shutdown()
    recorder.record(createMetric('FCP', 2000))

    expect(getHistogram(expectedInstruments.FCP.name).records).toHaveLength(1)
  })

  it('force-flushes and shuts down the meter provider idempotently', async () => {
    const runtime = await startBrowserMetrics({ metricUrl: '/v1/metrics/browser' }, { attributes: {} } as never)
    const provider = mocks.providers[0]
    expect(provider).toBeDefined()

    await runtime.forceFlush()
    await runtime.shutdown()
    await runtime.shutdown()
    await runtime.forceFlush()

    expect(provider?.forceFlushCalls).toBe(1)
    expect(provider?.shutdownCalls).toBe(1)
  })
})
