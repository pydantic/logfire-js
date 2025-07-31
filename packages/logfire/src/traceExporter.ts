import { Context } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor, ReadableSpan, SimpleSpanProcessor, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { logfireConfig } from './logfireConfig'
import { LogfireConsoleSpanExporter } from './LogfireConsoleSpanExporter'
import { VoidTraceExporter } from './VoidTraceExporter'

export function logfireSpanProcessor(enableConsole: boolean | undefined) {
  return new LogfireSpanProcessor(new BatchSpanProcessor(traceExporter()), Boolean(enableConsole))
}

/**
 * returns an OTLPTraceExporter instance pointing to the Logfire endpoint.
 */
export function traceExporter(): SpanExporter {
  if (!logfireConfig.sendToLogfire) {
    return new VoidTraceExporter()
  }

  const token = logfireConfig.token
  if (!token) {
    // TODO: what should be done here? We're forcing sending to logfire, but we don't have a token
    throw new Error('Logfire token is required')
  }

  return new OTLPTraceExporter({
    headers: logfireConfig.authorizationHeaders,
    url: logfireConfig.traceExporterUrl,
  })
}

class LogfireSpanProcessor implements SpanProcessor {
  private console?: SpanProcessor
  private wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor, enableConsole: boolean) {
    if (enableConsole) {
      this.console = new SimpleSpanProcessor(new LogfireConsoleSpanExporter())
    }
    this.wrapped = wrapped
  }

  async forceFlush(): Promise<void> {
    await this.console?.forceFlush()
    return this.wrapped.forceFlush()
  }

  onEnd(span: ReadableSpan): void {
    this.console?.onEnd(span)
    // Note: this is too late for the regular node instrumentation. The opentelemetry API rejects the non-primitive attribute values.
    // Instead, the serialization happens at the `logfire.span, logfire.startSpan`, etc.
    // Object.assign(span.attributes, serializeAttributes(span.attributes))
    this.wrapped.onEnd(span)
  }

  onStart(span: Span, parentContext: Context): void {
    this.console?.onStart(span, parentContext)
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    await this.console?.shutdown()
    return this.wrapped.shutdown()
  }
}
