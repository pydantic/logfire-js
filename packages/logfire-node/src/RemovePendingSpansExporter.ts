import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

const LOGFIRE_SPAN_TYPE_KEY = 'logfire.span_type'

/**
 * Drops pending spans whose final span is in the same export batch. Most spans finish within one
 * batch window, so their pending placeholder only duplicates the final span. Mirrors the Python
 * SDK's `RemovePendingSpansExporter`.
 */
export class RemovePendingSpansExporter implements SpanExporter {
  private readonly wrapped: SpanExporter

  constructor(wrapped: SpanExporter) {
    this.wrapped = wrapped
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Any non-pending span can be a final span: auto-instrumentation spans carry no
    // `logfire.span_type`, yet PendingSpanProcessor still emits pending spans for them.
    const finishedSpanKeys = new Set<string>()
    for (const span of spans) {
      if (!isPendingSpan(span)) {
        const { spanId, traceId } = span.spanContext()
        finishedSpanKeys.add(`${traceId}:${spanId}`)
      }
    }

    const result = spans.filter((span) => {
      if (!isPendingSpan(span) || span.parentSpanContext === undefined) {
        return true
      }
      // A pending span's parent context is the context of the real span it stands in for.
      const { spanId, traceId } = span.parentSpanContext
      return !finishedSpanKeys.has(`${traceId}:${spanId}`)
    })

    this.wrapped.export(result, resultCallback)
  }

  async forceFlush(): Promise<void> {
    await this.wrapped.forceFlush?.()
  }

  async shutdown(): Promise<void> {
    await this.wrapped.shutdown()
  }
}

export function isPendingSpan(span: ReadableSpan): boolean {
  return span.attributes[LOGFIRE_SPAN_TYPE_KEY] === 'pending_span'
}
