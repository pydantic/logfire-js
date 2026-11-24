import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api'
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { describe, expect, test, vi } from 'vite-plus/test'

import { ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { PendingSpanProcessor } from './PendingSpanProcessor'
import { TailSamplingProcessor } from './TailSamplingProcessor'

const REMOTE_PARENT = {
  isRemote: true,
  spanId: '00f067aa0ba902b7',
  traceFlags: TraceFlags.SAMPLED,
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
}

function records(exporter: InMemorySpanExporter): { name: string; parentSpanId: string | undefined; spanType: unknown }[] {
  return exporter.getFinishedSpans().map((span: ReadableSpan) => ({
    name: span.name,
    parentSpanId: span.parentSpanContext?.spanId,
    spanType: span.attributes[ATTRIBUTES_SPAN_TYPE_KEY],
  }))
}

describe('tail sampling with a remote parent', () => {
  test('exports one pending span per open span across an export, then each finished span once', async () => {
    const exporter = new InMemorySpanExporter()
    const primary = new BatchSpanProcessor(exporter, { scheduledDelayMillis: 60_000 })
    // Returns 0, so the spans are exported only because a remote-parent trace bypasses tail sampling.
    const tail = vi.fn<() => number>(() => 0.0)
    const provider = new BasicTracerProvider({
      spanProcessors: [new TailSamplingProcessor(primary, tail, { deferredProcessor: new PendingSpanProcessor(primary) })],
    })

    try {
      const tracer = provider.getTracer('test')
      const spanAttributes = { attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' } }
      const span = tracer.startSpan('GET /turn', spanAttributes, trace.setSpanContext(ROOT_CONTEXT, REMOTE_PARENT))
      const spanId = span.spanContext().spanId
      const child = tracer.startSpan('run agent', spanAttributes, trace.setSpan(ROOT_CONTEXT, span))
      const childId = child.spanContext().spanId

      await provider.forceFlush()
      expect(records(exporter)).toEqual([
        { name: 'GET /turn', parentSpanId: spanId, spanType: 'pending_span' },
        { name: 'run agent', parentSpanId: childId, spanType: 'pending_span' },
      ])

      child.end()
      span.end()
      await provider.forceFlush()
      expect(records(exporter)).toEqual([
        { name: 'GET /turn', parentSpanId: spanId, spanType: 'pending_span' },
        { name: 'run agent', parentSpanId: childId, spanType: 'pending_span' },
        { name: 'run agent', parentSpanId: spanId, spanType: 'span' },
        { name: 'GET /turn', parentSpanId: REMOTE_PARENT.spanId, spanType: 'span' },
      ])
      expect(tail).not.toHaveBeenCalled()
    } finally {
      await provider.shutdown()
    }
  })
})
