import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'

// First implementation, completely synchronous, more tested.

export class MultiSpanExporter implements SpanExporter {
  private readonly exporters: SpanExporter[]
  constructor(exporters: SpanExporter[]) {
    this.exporters = exporters
  }

  export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const exporter of this.exporters) {
      exporter.export(items, resultCallback)
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map(async (exporter) => exporter.shutdown()))
  }
}

// async

export class MultiSpanExporterAsync implements SpanExporter {
  private readonly exporters: SpanExporter[]
  constructor(exporters: SpanExporter[]) {
    this.exporters = exporters
  }

  export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const promises = this.exporters.map(
      async (exporter) =>
        new Promise<ExportResult>((resolve) => {
          exporter.export(items, resolve)
        })
    )

    Promise.all(promises).then(
      (results) => {
        const failed = results.filter((result) => result.code === ExportResultCode.FAILED)
        if (failed.length > 0) {
          // not ideal, but just return the first error
          const error = failed[0]?.error
          resultCallback(error === undefined ? { code: ExportResultCode.FAILED } : { code: ExportResultCode.FAILED, error })
        } else {
          resultCallback({ code: ExportResultCode.SUCCESS })
        }
      },
      (error: unknown) => {
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
      }
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map(async (exporter) => exporter.shutdown()))
  }
}
