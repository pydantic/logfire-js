import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'

type ExportResultCallback = (result: ExportResult) => void

function resultFromError(error: unknown): ExportResult {
  return { code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) }
}

function combinedExportResult(results: ExportResult[]): ExportResult {
  const failed = results.find((result) => result.code === ExportResultCode.FAILED)
  if (failed) {
    return failed.error === undefined ? { code: ExportResultCode.FAILED } : { code: ExportResultCode.FAILED, error: failed.error }
  }
  return { code: ExportResultCode.SUCCESS }
}

function exportToAll(exporters: SpanExporter[], items: ReadableSpan[], resultCallback: ExportResultCallback): void {
  if (exporters.length === 0) {
    resultCallback({ code: ExportResultCode.SUCCESS })
    return
  }

  const results: ExportResult[] = []
  let pending = exporters.length

  const recordResult = (result: ExportResult): void => {
    results.push(result)
    pending -= 1
    if (pending === 0) {
      resultCallback(combinedExportResult(results))
    }
  }

  for (const exporter of exporters) {
    let settled = false
    const once = (result: ExportResult): void => {
      if (!settled) {
        settled = true
        recordResult(result)
      }
    }

    try {
      exporter.export(items, once)
    } catch (error) {
      once(resultFromError(error))
    }
  }
}

export class MultiSpanExporter implements SpanExporter {
  private readonly exporters: SpanExporter[]
  constructor(exporters: SpanExporter[]) {
    this.exporters = exporters
  }

  export(items: ReadableSpan[], resultCallback: ExportResultCallback): void {
    exportToAll(this.exporters, items, resultCallback)
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

  export(items: ReadableSpan[], resultCallback: ExportResultCallback): void {
    const promises = this.exporters.map(
      async (exporter) =>
        new Promise<ExportResult>((resolve) => {
          exporter.export(items, resolve)
        })
    )

    Promise.all(promises).then(
      (results) => {
        resultCallback(combinedExportResult(results))
      },
      (error: unknown) => {
        resultCallback(resultFromError(error))
      }
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map(async (exporter) => exporter.shutdown()))
  }
}
