/**
 * @vitest-environment jsdom
 */
import { trace } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import { createOtlpNetworkExportDelegate } from '@opentelemetry/otlp-exporter-base'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { BatchSpanProcessorBrowserConfig, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { DocumentHideChunkingExporter, splitNewestSpans } from './DocumentHideChunkingExporter'
import { LogfireSpanProcessor } from './LogfireSpanProcessor'

class RecordingExporter implements SpanExporter {
  readonly batches: string[][] = []
  readonly callbacks: ((result: ExportResult) => void)[] = []
  deferred = false

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.batches.push(spans.map((span) => span.name))
    if (this.deferred) {
      this.callbacks.push(resultCallback)
      return
    }
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

function createSpans(names: string[], payloadLength = 0): ReadableSpan[] {
  const provider = new WebTracerProvider()
  const tracer = provider.getTracer('test')
  return names.map((name) => {
    const span = tracer.startSpan(name, { attributes: { payload: 'x'.repeat(payloadLength) } })
    span.end()
    return span as unknown as ReadableSpan
  })
}

/** Runs the microtasks an event listener queued, and nothing else, like an unloading page. */
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

afterEach(() => {
  trace.disable()
})

describe('DocumentHideChunkingExporter', () => {
  it('passes a batch through unchanged outside a document-hide flush', () => {
    const inner = new RecordingExporter()
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    let result: ExportResult | undefined

    exporter.export(createSpans(['a', 'b', 'c', 'd', 'e'], 400), (exportResult) => {
      result = exportResult
    })

    expect(inner.batches).toEqual([['a', 'b', 'c', 'd', 'e']])
    expect(result).toEqual({ code: ExportResultCode.SUCCESS })
  })

  it('sends the newest spans of the whole flush first, then the rest, one request after the other', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    const results: ExportResult[] = []
    const record = (result: ExportResult) => {
      results.push(result)
    }

    const flush = exporter.withHideFlush(async () => {
      // The batch processor hands over one batch per `maxExportBatchSize`, oldest first.
      exporter.export(createSpans(['a', 'b', 'c'], 700), record)
      exporter.export(createSpans(['d', 'e', 'f'], 700), record)
      await Promise.resolve()
    })
    await drainMicrotasks()

    expect(inner.batches).toEqual([['e', 'f']])
    inner.callbacks[0]?.({ code: ExportResultCode.SUCCESS })
    await drainMicrotasks()
    expect(inner.batches).toEqual([
      ['e', 'f'],
      ['a', 'b', 'c', 'd'],
    ])
    expect(results).toEqual([])
    inner.callbacks[1]?.({ code: ExportResultCode.SUCCESS })
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }, { code: ExportResultCode.SUCCESS }])
    await flush
  })

  it('reports a failure of either request to every batch of the flush', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    const results: ExportResult[] = []
    const failure: ExportResult = { code: ExportResultCode.FAILED, error: new Error('rejected') }

    await exporter.withHideFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e'], 700), (result) => {
        results.push(result)
      })
      await Promise.resolve()
    })
    await drainMicrotasks()
    inner.callbacks[0]?.({ code: ExportResultCode.SUCCESS })
    await drainMicrotasks()
    inner.callbacks[1]?.(failure)

    expect(results).toEqual([failure])
  })

  it('regroups every batch the processor hands over inside forceFlush, behind the Logfire processor', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    const processorConfig: BatchSpanProcessorBrowserConfig = { disableAutoFlushOnDocumentHide: true, maxExportBatchSize: 3 }
    // The processor sits behind `LogfireSpanProcessor` in `configure`, which awaits before it delegates.
    const provider = new WebTracerProvider({
      spanProcessors: [new LogfireSpanProcessor(new BatchSpanProcessor(exporter, processorConfig), false)],
    })
    const tracer = provider.getTracer('test')
    // A full batch starts a regular export that stays in flight, so the next six spans queue up.
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      tracer.startSpan(name, { attributes: { payload: 'x'.repeat(700) } }).end()
    }
    expect(inner.batches).toEqual([['a', 'b', 'c']])

    const flush = exporter.withHideFlush(async () => provider.forceFlush())
    await drainMicrotasks()

    // Two queued batches, oldest first, become one newest-first request and one remainder.
    expect(inner.batches).toEqual([
      ['a', 'b', 'c'],
      ['h', 'i'],
    ])
    inner.callbacks[0]?.({ code: ExportResultCode.SUCCESS })
    inner.callbacks[1]?.({ code: ExportResultCode.SUCCESS })
    await drainMicrotasks()
    expect(inner.batches).toEqual([
      ['a', 'b', 'c'],
      ['h', 'i'],
      ['d', 'e', 'f', 'g'],
    ])
    inner.callbacks[2]?.({ code: ExportResultCode.SUCCESS })
    await flush
    await provider.shutdown()
  })

  it('sends the older request through an OTLP exporter limited to one request at a time', async () => {
    const sends: { bytes: number; resolve: () => void }[] = []
    const delegate = createOtlpNetworkExportDelegate(
      { compression: 'none', concurrencyLimit: 1, timeoutMillis: 1_000 },
      JsonTraceSerializer,
      {
        send: async (data: Uint8Array) =>
          new Promise((resolve) => {
            sends.push({
              bytes: data.byteLength,
              resolve: () => {
                resolve({ status: 'success' })
              },
            })
          }),
        shutdown: () => {
          return undefined
        },
      }
    )
    const exporter = new DocumentHideChunkingExporter(delegate, 3_000)
    const results: ExportResult[] = []

    await exporter.withHideFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e'], 700), (result) => {
        results.push(result)
      })
      await Promise.resolve()
    })
    await drainMicrotasks()
    expect(sends).toHaveLength(1)

    sends[0]?.resolve()
    await drainMicrotasks()
    expect(sends).toHaveLength(2)
    expect(sends[1]?.bytes ?? 0).toBeGreaterThan(sends[0]?.bytes ?? 0)
    expect(results).toEqual([])

    sends[1]?.resolve()
    await drainMicrotasks()
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }])
  })

  it('never leaves the newest span behind, whatever the budget', () => {
    const { newest, older } = splitNewestSpans(createSpans(['old', 'new'], 5_000), 1)

    expect(newest.map((span) => span.name)).toEqual(['new'])
    expect(older.map((span) => span.name)).toEqual(['old'])
  })

  it('measures the serialized request, so the first request stays under the budget', () => {
    const provider = new WebTracerProvider()
    const tracer = provider.getTracer('test')
    const spans: ReadableSpan[] = []
    for (let index = 0; index < 40; index += 1) {
      const span = tracer.startSpan(`GET /api/resource/${String(index)}`, {
        attributes: {
          'http.url': `https://app.example.com/api/organizations/éxample/projects/example/resource/${String(index)}?q="quoted"`,
          'http.method': 'GET',
          'http.status_code': 200,
          'session.id': '0123456789abcdef0123456789abcdef',
          'user_agent.original': navigator.userAgent,
          tags: ['frontend', 'resource'],
        },
      })
      span.addEvent('fetchStart', { 'http.request.size': 0 })
      span.end()
      spans.push(span as unknown as ReadableSpan)
    }
    const budget = 12_000
    const { newest, older } = splitNewestSpans(spans, budget)
    expect(newest.length).toBeGreaterThan(1)
    expect(older.length).toBeGreaterThan(0)

    const serialized = JsonTraceSerializer.serializeRequest(newest)?.byteLength ?? 0
    const oneMore = JsonTraceSerializer.serializeRequest(spans.slice(spans.length - newest.length - 1))?.byteLength ?? 0
    expect(serialized).toBeLessThanOrEqual(budget)
    expect(oneMore).toBeGreaterThan(budget)
  })
})
