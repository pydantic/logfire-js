import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { ExportResultCode } from '@opentelemetry/core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { TailWorkerExporter } from './TailWorkerExporter'

// The tail worker forwards whatever object with a `resourceSpans` key it finds in the log
// stream, so what this exporter writes is the wire payload.
const fakeSpan = (name: string): ReadableSpan =>
  ({
    attributes: {},
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    duration: [0, 1_000],
    endTime: [1, 0],
    events: [],
    instrumentationScope: { name: 'test' },
    kind: 0,
    links: [],
    name,
    resource: { attributes: {} },
    spanContext: () => ({ spanId: '0000000000000001', traceFlags: 1, traceId: '00000000000000000000000000000001' }),
    startTime: [0, 0],
    status: { code: 0 },
  }) as unknown as ReadableSpan

describe('TailWorkerExporter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes nothing for an empty batch or a shutdown', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const exporter = new TailWorkerExporter()
    const results: ExportResult[] = []

    exporter.export([], (result) => {
      results.push(result)
    })
    await exporter.shutdown()

    expect(log).not.toHaveBeenCalled()
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }])
  })

  it('writes the payload for a batch that has spans', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const exporter = new TailWorkerExporter()
    const results: ExportResult[] = []

    exporter.export([fakeSpan('real-span')], (result) => {
      results.push(result)
    })

    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }])
    expect(log).toHaveBeenCalledTimes(1)
    const payload = log.mock.calls[0]?.[0] as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }
    expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe('real-span')
  })
})
