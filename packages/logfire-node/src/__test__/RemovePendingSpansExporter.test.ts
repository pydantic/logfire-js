import type { Attributes, Span } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { context, trace } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { PendingSpanProcessor } from 'logfire'
import { describe, expect, it, vi } from 'vite-plus/test'

import { RemovePendingSpansExporter } from '../RemovePendingSpansExporter'

const ATTRIBUTES_SPAN_TYPE_KEY = 'logfire.span_type'

function setup() {
  const exporter = new InMemorySpanExporter()
  const processor = new SimpleSpanProcessor(exporter)
  const provider = new BasicTracerProvider({ spanProcessors: [processor, new PendingSpanProcessor(processor)] })
  const tracer = provider.getTracer('test')

  const startSpan = (name: string, attributes: Attributes = { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, parent?: Span) =>
    tracer.startSpan(name, { attributes }, parent === undefined ? context.active() : trace.setSpan(context.active(), parent))
  const log = (name: string, parent: Span) => {
    startSpan(name, { [ATTRIBUTES_SPAN_TYPE_KEY]: 'log' }, parent).end()
  }

  // Simulates the batch span processor handing its queue to the exporter.
  const takeBatch = () => {
    const batch = exporter.getFinishedSpans()
    exporter.reset()
    return batch
  }

  return { log, startSpan, takeBatch }
}

function exportThrough(batch: ReadableSpan[], options?: { dropAll?: boolean }): [string, unknown][] {
  const inner = new InMemorySpanExporter()
  new RemovePendingSpansExporter(inner, options).export(batch, () => undefined)
  return inner.getFinishedSpans().map((span) => [span.name, span.attributes[ATTRIBUTES_SPAN_TYPE_KEY]])
}

describe('RemovePendingSpansExporter', () => {
  it('drops pending spans only when their final span is in the same batch', () => {
    const { log, startSpan, takeBatch } = setup()

    const span1 = startSpan('span1')
    log('log1', span1)
    span1.end()

    const span2 = startSpan('span2')
    log('log2', span2)
    const batch1 = takeBatch()
    log('log3', span2)
    span2.end()

    const span3 = startSpan('span3')
    log('log4', span3)
    span3.end()
    const batch2 = takeBatch()

    expect(exportThrough(batch1)).toEqual([
      ['log1', 'log'],
      ['span1', 'span'],
      ['span2', 'pending_span'],
      ['log2', 'log'],
    ])
    expect(exportThrough(batch2)).toEqual([
      ['log3', 'log'],
      ['span2', 'span'],
      ['log4', 'log'],
      ['span3', 'span'],
    ])
  })

  it('drops pending spans of auto-instrumentation spans that carry no span type', () => {
    const { startSpan, takeBatch } = setup()

    startSpan('GET /users', {}).end()

    expect(exportThrough(takeBatch())).toEqual([['GET /users', undefined]])
  })

  it('keeps a pending span when only a different span with the same name finished', () => {
    const { startSpan, takeBatch } = setup()

    const running = startSpan('work')
    startSpan('work').end()

    expect(exportThrough(takeBatch())).toEqual([
      ['work', 'pending_span'],
      ['work', 'span'],
    ])
    running.end()
  })

  it('drops every pending span with dropAll', () => {
    const { log, startSpan, takeBatch } = setup()

    const running = startSpan('running')
    log('log1', running)
    startSpan('finished').end()

    expect(exportThrough(takeBatch(), { dropAll: true })).toEqual([
      ['log1', 'log'],
      ['finished', 'span'],
    ])
    running.end()
  })

  it('delegates the export result, flush, and shutdown to the wrapped exporter', async () => {
    const failure = { code: ExportResultCode.FAILED, error: new Error('export failed') }
    const forceFlush = vi.fn<() => Promise<void>>(async () => Promise.resolve())
    const shutdown = vi.fn<() => Promise<void>>(async () => Promise.resolve())
    const exporter = new RemovePendingSpansExporter({
      export: (_spans, resultCallback) => {
        resultCallback(failure)
      },
      forceFlush,
      shutdown,
    })
    const resultCallback = vi.fn<(result: ExportResult) => void>()

    exporter.export([], resultCallback)
    await exporter.forceFlush()
    await exporter.shutdown()

    expect(resultCallback).toHaveBeenCalledWith(failure)
    expect(forceFlush).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
