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

  it('sends the newest spans of the whole flush first and the rest in the same task', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    const results: ExportResult[] = []
    const record = (result: ExportResult) => {
      results.push(result)
    }

    const flush = exporter.withNewestFirstFlush(async () => {
      // The batch processor hands over one batch per `maxExportBatchSize`, oldest first.
      exporter.export(createSpans(['a', 'b', 'c'], 700), record)
      exporter.export(createSpans(['d', 'e', 'f'], 700), record)
      await Promise.resolve()
    })
    await drainMicrotasks()

    // A page that unloads never receives the first response, so the second request cannot wait for it.
    expect(inner.batches).toEqual([
      ['e', 'f'],
      ['a', 'b', 'c', 'd'],
    ])
    inner.callbacks[0]?.({ code: ExportResultCode.SUCCESS })
    expect(results).toEqual([])
    inner.callbacks[1]?.({ code: ExportResultCode.SUCCESS })
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }, { code: ExportResultCode.SUCCESS }])
    await flush
  })

  it('sends the flush unsplit when fewer than two export slots are free', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000, 2)
    const results: ExportResult[] = []
    // A regular export holds one of the two slots.
    exporter.export(createSpans(['timer'], 700), () => undefined)

    const flush = exporter.withNewestFirstFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e', 'f'], 700), (result) => {
        results.push(result)
      })
      await Promise.resolve()
    })
    await drainMicrotasks()

    // A split would send its second request into a full queue, and the exporter would drop it.
    expect(inner.batches).toEqual([['timer'], ['a', 'b', 'c', 'd', 'e', 'f']])
    inner.callbacks[1]?.({ code: ExportResultCode.SUCCESS })
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }])
    await flush
  })

  it('splits again once an export frees its slot', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000, 2)
    exporter.export(createSpans(['timer'], 700), () => undefined)
    inner.callbacks[0]?.({ code: ExportResultCode.SUCCESS })

    const flush = exporter.withNewestFirstFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e', 'f'], 700), () => undefined)
      await Promise.resolve()
    })
    await drainMicrotasks()

    expect(inner.batches).toEqual([['timer'], ['e', 'f'], ['a', 'b', 'c', 'd']])
    inner.callbacks[1]?.({ code: ExportResultCode.SUCCESS })
    inner.callbacks[2]?.({ code: ExportResultCode.SUCCESS })
    await flush
  })

  it('reports a failure of either request to every batch of the flush', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    const results: ExportResult[] = []
    const failure: ExportResult = { code: ExportResultCode.FAILED, error: new Error('rejected') }

    await exporter.withNewestFirstFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e'], 700), (result) => {
        results.push(result)
      })
      await Promise.resolve()
    })
    await drainMicrotasks()
    inner.callbacks[1]?.(failure)
    expect(results).toEqual([])
    inner.callbacks[0]?.({ code: ExportResultCode.SUCCESS })

    expect(results).toEqual([failure])
  })

  it('reports the failure of the newest request when both fail', async () => {
    const inner = new RecordingExporter()
    inner.deferred = true
    const exporter = new DocumentHideChunkingExporter(inner, 3_000)
    const results: ExportResult[] = []
    const newestFailure: ExportResult = { code: ExportResultCode.FAILED, error: new Error('newest rejected') }
    const olderFailure: ExportResult = { code: ExportResultCode.FAILED, error: new Error('older rejected') }

    await exporter.withNewestFirstFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e'], 700), (result) => {
        results.push(result)
      })
      await Promise.resolve()
    })
    await drainMicrotasks()
    inner.callbacks[1]?.(olderFailure)
    inner.callbacks[0]?.(newestFailure)

    expect(results).toEqual([newestFailure])
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

    const flush = exporter.withNewestFirstFlush(async () => provider.forceFlush())
    await drainMicrotasks()

    // Two queued batches, oldest first, become one newest-first request and one remainder.
    expect(inner.batches).toEqual([
      ['a', 'b', 'c'],
      ['h', 'i'],
      ['d', 'e', 'f', 'g'],
    ])
    for (const callback of inner.callbacks) {
      callback({ code: ExportResultCode.SUCCESS })
    }
    await flush
    await provider.shutdown()
  })

  it('starts both requests through the OTLP exporter before either response arrives', async () => {
    const sends: { bytes: number; resolve: () => void }[] = []
    const delegate = createOtlpNetworkExportDelegate(
      { compression: 'none', concurrencyLimit: 2, timeoutMillis: 1_000 },
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

    await exporter.withNewestFirstFlush(async () => {
      exporter.export(createSpans(['a', 'b', 'c', 'd', 'e'], 700), (result) => {
        results.push(result)
      })
      await Promise.resolve()
    })
    await drainMicrotasks()
    expect(sends).toHaveLength(2)
    expect(sends[1]?.bytes ?? 0).toBeGreaterThan(sends[0]?.bytes ?? 0)

    sends[0]?.resolve()
    await drainMicrotasks()
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
