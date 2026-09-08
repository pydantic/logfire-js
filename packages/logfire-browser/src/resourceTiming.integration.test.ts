/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { configure } from './index'

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
  vi.restoreAllMocks()
})

describe('browser resource timing', () => {
  it.each([
    ['summary' as const, false],
    ['full' as const, true],
  ])('exports document and resource spans with %s detail', async (detail, includesNetworkEvents) => {
    const navigation = createNavigationTiming()
    const resources = ['script', 'css', 'font', 'img'].map((initiatorType, index) => createResourceTiming(initiatorType, index))
    const getEntriesByType = (type: string): PerformanceEntry[] => {
      if (type === 'navigation') {
        return [navigation]
      }
      if (type === 'resource') {
        return resources
      }
      if (type === 'paint') {
        return [{ entryType: 'paint', name: 'first-contentful-paint', startTime: 95 } as unknown as PerformancePaintTiming]
      }
      return []
    }
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(getEntriesByType as typeof performance.getEntriesByType)
    const exporter = new InMemorySpanExporter()
    const cleanup = configure({
      autoInstrumentations: {
        '@opentelemetry/instrumentation-document-load': { enabled: true },
        '@opentelemetry/instrumentation-fetch': { enabled: false },
        '@opentelemetry/instrumentation-user-interaction': { enabled: false },
        '@opentelemetry/instrumentation-xml-http-request': { enabled: false },
      },
      resourceTiming: { detail },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      await waitUntil(() => exporter.getFinishedSpans().length === 6)
      const spans = exporter.getFinishedSpans()
      expect(spans.map(({ name }) => name).sort()).toEqual([
        'documentFetch',
        'documentLoad',
        'resourceFetch',
        'resourceFetch',
        'resourceFetch',
        'resourceFetch',
      ])

      const documentLoad = spans.find(({ name }) => name === 'documentLoad')
      const documentFetch = spans.find(({ name }) => name === 'documentFetch')
      const resourceSpans = spans.filter(({ name }) => name === 'resourceFetch')
      expect(documentLoad?.duration).toEqual([0, 110_000_000])
      expect(documentFetch?.duration).toEqual([0, 80_000_000])
      expect(resourceSpans.map(({ duration }) => duration)).toEqual([
        [0, 25_000_000],
        [0, 25_000_000],
        [0, 25_000_000],
        [0, 25_000_000],
      ])
      expect(resourceSpans.map(({ attributes }) => attributes['http.url'])).toEqual(resources.map(({ name }) => name))
      expect(resourceSpans.map(({ attributes }) => attributes['http.response_content_length'])).toEqual(
        resources.map(({ encodedBodySize }) => encodedBodySize)
      )
      expect(resourceSpans.map(({ attributes }) => attributes['http.response_content_length_uncompressed'])).toEqual(
        resources.map(({ decodedBodySize }) => decodedBodySize)
      )
      expect(documentFetch?.attributes).toMatchObject({
        'http.response_content_length': navigation.encodedBodySize,
        'http.response_content_length_uncompressed': navigation.decodedBodySize,
      })
      expect(documentLoad?.events.map(({ name }) => name)).toEqual(
        includesNetworkEvents
          ? [
              'fetchStart',
              'unloadEventStart',
              'unloadEventEnd',
              'domInteractive',
              'domContentLoadedEventStart',
              'domContentLoadedEventEnd',
              'domComplete',
              'loadEventStart',
              'loadEventEnd',
              'firstContentfulPaint',
            ]
          : ['firstContentfulPaint']
      )
      const fetchAndResourceEventNames = [
        'fetchStart',
        'domainLookupStart',
        'domainLookupEnd',
        'connectStart',
        'secureConnectionStart',
        'connectEnd',
        'requestStart',
        'responseStart',
        'responseEnd',
      ]
      expect(documentFetch?.events.map(({ name }) => name)).toEqual(includesNetworkEvents ? fetchAndResourceEventNames : [])
      for (const span of resourceSpans) {
        expect(span.events.map(({ name }) => name)).toEqual(includesNetworkEvents ? fetchAndResourceEventNames : [])
        expect(span.parentSpanContext?.spanId).toBe(documentLoad?.spanContext().spanId)
      }
      expect(documentFetch?.parentSpanContext?.spanId).toBe(documentLoad?.spanContext().spanId)
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
    throw new Error('timed out waiting for resource timing spans')
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  return waitUntilDeadline(predicate, deadline)
}

function createNavigationTiming(): PerformanceNavigationTiming {
  return {
    connectEnd: 30,
    connectStart: 20,
    decodedBodySize: 1_200,
    domComplete: 105,
    domContentLoadedEventEnd: 100,
    domContentLoadedEventStart: 98,
    domInteractive: 90,
    domainLookupEnd: 20,
    domainLookupStart: 15,
    duration: 110,
    encodedBodySize: 1_000,
    entryType: 'navigation',
    fetchStart: 10,
    loadEventEnd: 120,
    loadEventStart: 110,
    name: 'http://localhost:3000/',
    navigationStart: 0,
    nextHopProtocol: 'h2',
    redirectEnd: 0,
    redirectStart: 0,
    requestStart: 35,
    responseEnd: 90,
    responseStart: 50,
    secureConnectionStart: 25,
    serverTiming: [],
    startTime: 0,
    toJSON: () => ({}),
    transferSize: 1_100,
    type: 'navigate',
    unloadEventEnd: 8,
    unloadEventStart: 5,
    workerStart: 0,
  } as unknown as PerformanceNavigationTiming
}

function createResourceTiming(initiatorType: string, index: number): PerformanceResourceTiming {
  const offset = index * 30
  return {
    connectEnd: 25 + offset,
    connectStart: 20 + offset,
    decodedBodySize: 2_000 + index,
    domainLookupEnd: 20 + offset,
    domainLookupStart: 15 + offset,
    duration: 25,
    encodedBodySize: 1_500 + index,
    entryType: 'resource',
    fetchStart: 10 + offset,
    initiatorType,
    name: `http://localhost:3000/static/asset-${String(index)}`,
    nextHopProtocol: 'h2',
    redirectEnd: 0,
    redirectStart: 0,
    requestStart: 27 + offset,
    responseEnd: 35 + offset,
    responseStart: 30 + offset,
    secureConnectionStart: 22 + offset,
    serverTiming: [],
    startTime: 10 + offset,
    toJSON: () => ({}),
    transferSize: 1_700 + index,
    workerStart: 0,
  } as unknown as PerformanceResourceTiming
}
