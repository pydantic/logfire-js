import type { Context } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { scrubSpanForExport } from 'logfire'

import { logfireConfig } from './logfireConfig'
import { USER_AGENT } from './userAgent'
import { LogfireConsoleSpanExporter } from './LogfireConsoleSpanExporter'
import type { ConsoleConfig } from './consoleOptions'
import { resolveConsoleOptions } from './consoleOptions'
import { isPendingSpan, RemovePendingSpansExporter } from './RemovePendingSpansExporter'
import { VoidTraceExporter } from './VoidTraceExporter'

export function logfireSpanProcessor(consoleConfig: ConsoleConfig | undefined): SpanProcessor {
  const consoleOptions = resolveConsoleOptions(consoleConfig)
  const consoleProcessor = consoleOptions.enabled ? new SimpleSpanProcessor(new LogfireConsoleSpanExporter(consoleOptions)) : undefined
  return new LogfireSpanProcessor(new BatchSpanProcessor(traceExporter()), consoleProcessor, { pendingSpans: logfireConfig.pendingSpans })
}

/**
 * returns an OTLPTraceExporter instance pointing to the Logfire endpoint.
 */
export function traceExporter(): SpanExporter {
  if (!logfireConfig.sendToLogfire) {
    return new VoidTraceExporter()
  }

  const token = logfireConfig.token
  if (!(typeof token === 'function' || (token !== undefined && token !== ''))) {
    // TODO: what should be done here? We're forcing sending to logfire, but we don't have a token
    throw new Error('Logfire token is required')
  }

  return new RemovePendingSpansExporter(
    new OTLPTraceExporter({
      headers: logfireConfig.authorizationHeaders,
      url: logfireConfig.traceExporterUrl,
      userAgent: USER_AGENT,
    })
  )
}

export class LogfireSpanProcessor implements SpanProcessor {
  private readonly console: SpanProcessor | undefined
  private readonly pendingSpans: boolean
  private readonly wrapped: SpanProcessor

  constructor(
    wrapped: SpanProcessor,
    consoleProcessor: SpanProcessor | undefined,
    { pendingSpans = true }: { pendingSpans?: boolean } = {}
  ) {
    this.console = consoleProcessor
    this.pendingSpans = pendingSpans
    this.wrapped = wrapped
  }

  async forceFlush(): Promise<void> {
    await settleBoth('logfire SDK: span processor forceFlush failed', [this.console?.forceFlush(), this.wrapped.forceFlush()])
  }

  onEnd(span: ReadableSpan): void {
    // Serialization has to happen when `logfire.span` and friends create the span, because the
    // OpenTelemetry API rejects non-primitive attribute values. Scrubbing primitives here also covers
    // instrumentation spans, attributes set after creation, events, and links.
    scrubSpanForExport(span)
    this.console?.onEnd(span)

    // Dropped before the batch queue, not at export, so discarded placeholders never take queue slots from real spans.
    if (this.pendingSpans || !isPendingSpan(span)) {
      this.wrapped.onEnd(span)
    }
  }

  onStart(span: Span, parentContext: Context): void {
    this.console?.onStart(span, parentContext)
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    await settleBoth('logfire SDK: span processor shutdown failed', [this.console?.shutdown(), this.wrapped.shutdown()])
  }
}

/**
 * Start both lifecycle calls at once and report every failure. Awaiting them in sequence skipped
 * the batch processor — the half whose queued spans are unrecoverable — exactly when the console
 * half rejected, the shape `TailSamplingProcessor.runBoth` and the SDK's `settleWithDeadline`
 * already settled. A lone failure is rethrown unchanged to keep the existing rejection contract.
 */
async function settleBoth(label: string, operations: (Promise<void> | undefined)[]): Promise<void> {
  const errors: unknown[] = []
  await Promise.all(
    operations.map(async (operation) => {
      try {
        await operation
      } catch (e: unknown) {
        errors.push(e)
      }
    })
  )
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, label)
  }
}
