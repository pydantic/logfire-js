/**
 * Test helper: spin up an InMemoryLogRecordExporter wired to the OTel logs API
 * so we can assert on emitted `gen_ai.evaluation.result` log records.
 */

import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'

import { context as ContextAPI, trace as TraceAPI } from '@opentelemetry/api'
import { logs as LogsAPI } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { getEvalsSpanProcessor } from '../spanTree'

let installedContextManager: AsyncLocalStorageContextManager | null = null

export interface WithMemoryLogExporterResult<R> {
  logs: ReadableLogRecord[]
  result: R
  spans: import('@opentelemetry/sdk-trace-base').ReadableSpan[]
}

export async function withMemoryLogExporter<R>(fn: () => Promise<R> | R): Promise<WithMemoryLogExporterResult<R>> {
  const spanExporter = new InMemorySpanExporter()
  const logExporter = new InMemoryLogRecordExporter()

  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter), getEvalsSpanProcessor()],
  })
  TraceAPI.setGlobalTracerProvider(tracerProvider)

  const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(logExporter)] })
  LogsAPI.setGlobalLoggerProvider(loggerProvider)

  if (installedContextManager === null) {
    installedContextManager = new AsyncLocalStorageContextManager()
    installedContextManager.enable()
    ContextAPI.setGlobalContextManager(installedContextManager)
  }

  try {
    const result = await fn()
    await tracerProvider.forceFlush()
    await loggerProvider.forceFlush()
    return { logs: logExporter.getFinishedLogRecords(), result, spans: spanExporter.getFinishedSpans() }
  } finally {
    await tracerProvider.shutdown()
    await loggerProvider.shutdown()
    TraceAPI.disable()
    LogsAPI.disable()
  }
}
