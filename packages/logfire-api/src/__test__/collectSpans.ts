/**
 * Test helper: spin up a real `BasicTracerProvider` + `InMemorySpanExporter`,
 * let the caller assemble the processor pipeline around the exporter's primary
 * processor, configure the Logfire API, run the test body, and return the
 * captured spans. Asserting against actual exporter output catches issues that
 * mock-based tests miss (span kind, span-type attributes, serialization, etc.).
 */

import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { trace as TraceAPI } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { configureLogfireApi } from '../index'

export async function collectSpans(
  createProcessors: (primary: SpanProcessor) => SpanProcessor[],
  run: () => void
): Promise<ReadableSpan[]> {
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
