import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { SpanKind, trace as TraceAPI } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { describe, expect, test } from 'vite-plus/test'

import type { SpanOptions } from './index'

import { ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { configureLogfireApi, info, instrument, span, startPendingSpan, startSpan } from './index'
import { PendingSpanProcessor } from './PendingSpanProcessor'

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

describe('span kind integration', () => {
  test('span() with the options object exports the provided kind', async () => {
    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        span('outbound request', { callback: () => undefined, kind: SpanKind.CLIENT })
      }
    )

    expect(spans.map((exported) => exported.kind)).toEqual([SpanKind.CLIENT])
  })

  test('span() with positional attributes and options exports the provided kind', async () => {
    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        span('handle request', {}, { kind: SpanKind.SERVER }, () => undefined)
      }
    )

    expect(spans.map((exported) => exported.kind)).toEqual([SpanKind.SERVER])
  })

  test('span() without a kind keeps the INTERNAL default', async () => {
    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        span('internal work', { callback: () => undefined })
      }
    )

    expect(spans.map((exported) => exported.kind)).toEqual([SpanKind.INTERNAL])
  })

  test('startSpan() exports the provided kind and defaults to INTERNAL', async () => {
    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        startSpan('publish message', {}, { kind: SpanKind.PRODUCER }).end()
        startSpan('plain work').end()
      }
    )

    expect(spans.map((exported) => exported.kind)).toEqual([SpanKind.PRODUCER, SpanKind.INTERNAL])
  })

  test('startPendingSpan() uses the same kind for the placeholder and the real span', async () => {
    const spans = await collectSpans(
      (primary) => [primary, new PendingSpanProcessor(primary)],
      () => {
        startPendingSpan('consume message', {}, { kind: SpanKind.CONSUMER }).end()
      }
    )

    expect(spans.map((exported) => [exported.attributes[ATTRIBUTES_SPAN_TYPE_KEY], exported.kind])).toEqual([
      ['pending_span', SpanKind.CONSUMER],
      ['span', SpanKind.CONSUMER],
    ])
  })

  test('log helpers stay INTERNAL when a runtime options object carries a kind', async () => {
    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        const sneakyOptions: SpanOptions = { kind: SpanKind.CLIENT }
        info('plain log', {}, sneakyOptions)
      }
    )

    expect(spans.map((exported) => [exported.attributes[ATTRIBUTES_SPAN_TYPE_KEY], exported.kind])).toEqual([['log', SpanKind.INTERNAL]])
  })

  test('instrument() exports the provided kind on the call span', async () => {
    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        const fetchRecords = instrument(() => 42, { kind: SpanKind.CLIENT })
        expect(fetchRecords()).toBe(42)
      }
    )

    expect(spans.map((exported) => exported.kind)).toEqual([SpanKind.CLIENT])
  })
})
