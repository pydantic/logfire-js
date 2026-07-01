import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { describe, expect, it, vitest } from 'vitest'
import { MultiSpanExporter } from '../src/multiexporter'

const spans = [] as ReadableSpan[]

function spanExporter(result: ExportResult): SpanExporter {
  return {
    export(_items, callback) {
      callback(result)
    },
    shutdown: async () => Promise.resolve(),
  }
}

describe('MultiSpanExporter', () => {
  it('calls the export callback once after all child exporters complete', () => {
    const error = new Error('export failed')
    const callback = vitest.fn<(result: ExportResult) => void>()
    const exporter = new MultiSpanExporter([
      spanExporter({ code: ExportResultCode.SUCCESS }),
      spanExporter({ code: ExportResultCode.FAILED, error }),
    ])

    exporter.export(spans, callback)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ code: ExportResultCode.FAILED, error })
  })
})
