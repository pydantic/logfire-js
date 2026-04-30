/* eslint-disable @typescript-eslint/no-empty-function */
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'

export class VoidTraceExporter implements SpanExporter {
  export(): void {}
  async forceFlush?(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
