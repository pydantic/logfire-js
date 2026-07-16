/* eslint-disable @typescript-eslint/no-empty-function */
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics'

export class VoidMetricExporter implements PushMetricExporter {
  export(_metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    // The exporter contract requires resolving the callback; PeriodicExportingMetricReader
    // flushes wait on it forever otherwise.
    resultCallback({ code: ExportResultCode.SUCCESS })
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
