/**
 * Test helper: spin up a real `BasicTracerProvider` + `InMemorySpanExporter`,
 * register the evals span processor, run the test body, return the captured
 * spans. Asserting against the actual exporter output catches issues that
 * mock-based tests miss (JSON-schema sidecar attrs, attribute serialization, etc.).
 */

import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { context as ContextAPI, trace as TraceAPI } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { getEvalsSpanProcessor } from '../spanTree'

let installedContextManager: AsyncLocalStorageContextManager | null = null

export interface WithMemoryExporterResult<R> {
  result: R
  spans: ReadableSpan[]
}

export async function withMemoryExporter<R>(fn: () => Promise<R> | R): Promise<WithMemoryExporterResult<R>> {
  const exporter = new InMemorySpanExporter()
  const userProcessor: SpanProcessor = new SimpleSpanProcessor(exporter)
  const evalsProcessor = getEvalsSpanProcessor()

  const provider = new BasicTracerProvider({ spanProcessors: [userProcessor, evalsProcessor] })
  TraceAPI.setGlobalTracerProvider(provider)

  if (installedContextManager === null) {
    installedContextManager = new AsyncLocalStorageContextManager()
    installedContextManager.enable()
    ContextAPI.setGlobalContextManager(installedContextManager)
  }

  try {
    const result = await fn()
    await provider.forceFlush()
    return { result, spans: exporter.getFinishedSpans() }
  } finally {
    await provider.shutdown()
    TraceAPI.disable()
  }
}
