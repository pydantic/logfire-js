import { Context } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor, BufferConfig, ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { serializeAttributes } from '@pydantic/logfire-api'

import { logfireConfig } from './logfireConfig'
import { VoidTraceExporter } from './VoidTraceExporter'

export function logfireSpanProcessor(config?: BufferConfig) {
  return new LogfireSpanProcessor(new BatchSpanProcessor(traceExporter(), config))
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
  private wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor) {
    this.wrapped = wrapped
  }

  async forceFlush(): Promise<void> {
    return this.wrapped.forceFlush()
  }

  onEnd(span: ReadableSpan): void {
    Object.assign(span.attributes, serializeAttributes(span.attributes, logfireConfig.scrubber))
    this.wrapped.onEnd(span)
  }

  onStart(span: Span, parentContext: Context): void {
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    return this.wrapped.shutdown()
  }
}
