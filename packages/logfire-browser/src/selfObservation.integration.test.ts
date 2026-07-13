/**
 * @vitest-environment jsdom
 */
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { startSessionReplay } from '@pydantic/logfire-session-replay'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const originalFetch = globalThis.fetch

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch, writable: true })
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('installed fetch instrumentation and public standalone replay', () => {
  it.each(['otel-first', 'replay-first'] as const)(
    'keeps application traffic observable and SDK traffic ignored when %s',
    async (order) => {
      const rawFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response('{}', { headers: { 'content-length': '2' }, status: 200 }))
      )
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: rawFetch, writable: true })
      const exporter = new InMemorySpanExporter()
      const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
      const instrumentation = new FetchInstrumentation({
        ignoreUrls: [/\/client-traces(?:[?#]|$)/u, /\/client-metrics(?:[?#]|$)/u, /\/client-replay\/[^/?#]+(?:\?|$)/u],
      })
      instrumentation.disable()
      instrumentation.setTracerProvider(provider)

      const startReplay = () =>
        startSessionReplay({
          captureConsole: false,
          captureNavigation: false,
          captureNetwork: true,
          flushIntervalMs: 60_000,
          getSessionId: () => 'browser-session',
          ignoreUrlPatterns: [/\/client-traces(?:[?#]|$)/u, /\/client-metrics(?:[?#]|$)/u, /\/client-replay\/[^/?#]+(?:\?|$)/u],
          onErrorSampleRate: 0,
          random: () => 0,
          replayUrl: '/client-replay',
          sessionSampleRate: 1,
        })

      let replay
      if (order === 'otel-first') {
        instrumentation.enable()
        replay = startReplay()
      } else {
        replay = startReplay()
        instrumentation.enable()
      }

      await globalThis.fetch('/api/application')
      const exporterBypass = Reflect.get(globalThis.fetch, '__original') as typeof fetch
      await exporterBypass('/client-traces')
      await globalThis.fetch('/client-metrics')
      await replay.flush()
      await new Promise((resolve) => {
        setTimeout(resolve, 350)
      })
      await provider.forceFlush()

      const spans = exporter.getFinishedSpans()
      if (order === 'otel-first') {
        await replay.stop()
        instrumentation.disable()
      } else {
        instrumentation.disable()
        await replay.stop()
      }
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: rawFetch, writable: true })
      await provider.shutdown()

      expect(spans).toHaveLength(1)
      expect(JSON.stringify(spans[0]?.attributes)).toContain('/api/application')
      expect(spans.some((span) => JSON.stringify(span.attributes).includes('client-traces'))).toBe(false)
      expect(spans.some((span) => JSON.stringify(span.attributes).includes('client-metrics'))).toBe(false)
      expect(spans.some((span) => JSON.stringify(span.attributes).includes('client-replay'))).toBe(false)
      expect(rawFetch.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual([
        'http://localhost:3000/api/application',
        '/client-traces',
        '/client-metrics',
        '/client-replay/browser-session?seq=0',
      ])
    }
  )
})

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}
