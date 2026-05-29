import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { trace as TraceAPI } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { describe, expect, test } from 'vite-plus/test'

import { ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { configureLogfireApi, startPendingSpan } from './index'
import { PendingSpanProcessor } from './PendingSpanProcessor'
import { TailSamplingProcessor } from './TailSamplingProcessor'

async function collectSpans(createProcessors: (primary: SpanProcessor) => SpanProcessor[], run: () => void): Promise<ReadableSpan[]> {
  const exporter = new InMemorySpanExporter()
  const primary = new SimpleSpanProcessor(exporter)
  const provider = new BasicTracerProvider({ spanProcessors: createProcessors(primary) })
  TraceAPI.setGlobalTracerProvider(provider)
  configureLogfireApi({ otelScope: 'logfire', scrubbing: false })

  try {
    run()
    await provider.forceFlush()
    return exporter.getFinishedSpans()
  } finally {
    await provider.shutdown()
    TraceAPI.disable()
  }
}

function pendingSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter((span) => span.attributes[ATTRIBUTES_SPAN_TYPE_KEY] === 'pending_span')
}

describe('startPendingSpan integration', () => {
  test('emits one manual pending span with non-tail automatic pending processing installed', async () => {
    const spans = await collectSpans(
      (primary) => [primary, new PendingSpanProcessor(primary)],
      () => {
        const span = startPendingSpan('manual root')
        span.end()
      }
    )

    expect(pendingSpans(spans)).toHaveLength(1)
    expect(spans.map((span) => span.attributes[ATTRIBUTES_SPAN_TYPE_KEY])).toEqual(['pending_span', 'span'])
  })

  test('emits one manual pending span when a tail-buffered trace is accepted on root end', async () => {
    const spans = await collectSpans(
      (primary) => [
        new TailSamplingProcessor(primary, (info) => (info.event === 'end' && info.span.name === 'manual root' ? 1.0 : 0.0), {
          deferredProcessor: new PendingSpanProcessor(primary),
        }),
      ],
      () => {
        const span = startPendingSpan('manual root')
        span.end()
      }
    )

    expect(pendingSpans(spans)).toHaveLength(1)
    expect(spans.map((span) => span.attributes[ATTRIBUTES_SPAN_TYPE_KEY])).toEqual(['pending_span', 'span'])
  })
})
