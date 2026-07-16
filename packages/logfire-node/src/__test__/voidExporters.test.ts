import type { ExportResult } from '@opentelemetry/core'
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics'

import { ExportResultCode } from '@opentelemetry/core'
import { describe, expect, it } from 'vite-plus/test'

import { VoidMetricExporter } from '../VoidMetricExporter'
import { VoidTraceExporter } from '../VoidTraceExporter'

describe('void exporters', () => {
  it('VoidTraceExporter.export invokes the result callback with SUCCESS', () => {
    const results: ExportResult[] = []
    new VoidTraceExporter().export([], (result) => {
      results.push(result)
    })
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }])
  })

  it('VoidMetricExporter.export invokes the result callback with SUCCESS', () => {
    const results: ExportResult[] = []
    new VoidMetricExporter().export({} as ResourceMetrics, (result) => {
      results.push(result)
    })
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }])
  })
})
