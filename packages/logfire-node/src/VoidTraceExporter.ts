/* eslint-disable @typescript-eslint/no-empty-function */
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

export class VoidTraceExporter implements SpanExporter {
  export(_spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // The exporter contract requires resolving the callback; BatchSpanProcessor
    // flushes wait on it forever otherwise.
    resultCallback({ code: ExportResultCode.SUCCESS })
  }
  async forceFlush?(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
