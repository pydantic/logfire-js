import type { HrTime } from '@opentelemetry/api'
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { MockInstance } from 'vite-plus/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { Level } from 'logfire'

import type { ResolvedConsoleOptions } from '../consoleOptions'
import { LogfireConsoleSpanExporter } from '../LogfireConsoleSpanExporter'
import { logfireSpanProcessor } from '../traceExporter'

const BASE_OPTIONS: ResolvedConsoleOptions = {
  enabled: true,
  includeTags: true,
  includeTimestamps: true,
  minLevel: Level.Info,
}

function makeSpan(attributes: ReadableSpan['attributes'] = {}): ReadableSpan {
  return {
    attributes,
    duration: [0, 123_000] as HrTime,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    endTime: [1000, 123_579_789] as HrTime,
    ended: true,
    events: [],
    instrumentationScope: { name: 'test-scope' },
    kind: SpanKind.INTERNAL,
    links: [],
    name: 'test span',
    parentSpanContext: undefined,
    resource: { attributes: { 'service.name': 'test-service' } },
    spanContext: () => ({
      isRemote: false,
      spanId: '2222222222222222',
      traceFlags: TraceFlags.SAMPLED,
      traceId: '11111111111111111111111111111111',
    }),
    startTime: [1000, 123_456_789] as HrTime,
    status: { code: SpanStatusCode.UNSET },
  } as unknown as ReadableSpan
}

function exportOne(exporter: LogfireConsoleSpanExporter, span: ReadableSpan): void {
  let resultCode: ExportResultCode | undefined
  exporter.export([span], (result) => {
    resultCode = result.code
  })
  expect(resultCode).toBe(ExportResultCode.SUCCESS)
}

describe('LogfireConsoleSpanExporter', () => {
  let logSpy: MockInstance<typeof console.log>
  let dirSpy: MockInstance<typeof console.dir>

  function getDirObject(callIndex: number): Record<string, unknown> {
    const value: unknown = dirSpy.mock.calls[callIndex]?.[0]
    expect(value).toBeDefined()
    expect(typeof value).toBe('object')
    return value as Record<string, unknown>
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dirSpy = vi.spyOn(console, 'dir').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the existing three-part output shape at info by default', () => {
    const span = makeSpan({
      'logfire.level_num': Level.Info,
      'logfire.tags': ['local'],
      item: 'checkout',
    })

    exportOne(new LogfireConsoleSpanExporter(), span)

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('info')
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('test span')
    expect(dirSpy).toHaveBeenCalledTimes(2)
    expect(getDirObject(0)).toEqual({
      'logfire.level_num': Level.Info,
      'logfire.tags': ['local'],
      item: 'checkout',
    })
    const metadata = getDirObject(1)
    expect(metadata['traceId']).toBe('11111111111111111111111111111111')
    expect(typeof metadata['duration']).toBe('number')
    expect(typeof metadata['timestamp']).toBe('number')
  })

  it('uses info as the default console minimum', () => {
    exportOne(
      new LogfireConsoleSpanExporter(),
      makeSpan({
        'logfire.level_num': Level.Debug,
      })
    )

    expect(logSpy).not.toHaveBeenCalled()
    expect(dirSpy).not.toHaveBeenCalled()
  })

  it('filters below the configured console min level and still reports success', () => {
    const exporter = new LogfireConsoleSpanExporter({
      ...BASE_OPTIONS,
      minLevel: Level.Warning,
    })

    exportOne(
      exporter,
      makeSpan({
        'logfire.level_num': Level.Info,
      })
    )

    expect(logSpy).not.toHaveBeenCalled()
    expect(dirSpy).not.toHaveBeenCalled()
  })

  it('prints spans at or above the configured console min level', () => {
    const exporter = new LogfireConsoleSpanExporter({
      ...BASE_OPTIONS,
      minLevel: Level.Warning,
    })

    exportOne(
      exporter,
      makeSpan({
        'logfire.level_num': Level.Warning,
      })
    )
    exportOne(
      exporter,
      makeSpan({
        'logfire.level_num': Level.Error,
      })
    )

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(dirSpy).toHaveBeenCalledTimes(4)
  })

  it('removes tags from printed attributes without mutating the span', () => {
    const attributes = {
      'logfire.level_num': Level.Info,
      'logfire.tags': ['local'],
      item: 'checkout',
    }

    exportOne(new LogfireConsoleSpanExporter({ ...BASE_OPTIONS, includeTags: false }), makeSpan(attributes))

    expect(getDirObject(0)).toEqual({
      'logfire.level_num': Level.Info,
      item: 'checkout',
    })
    expect(attributes).toEqual({
      'logfire.level_num': Level.Info,
      'logfire.tags': ['local'],
      item: 'checkout',
    })
  })

  it('removes timestamps from printed metadata', () => {
    exportOne(new LogfireConsoleSpanExporter({ ...BASE_OPTIONS, includeTimestamps: false }), makeSpan({ 'logfire.level_num': Level.Info }))

    const metadata = getDirObject(1)
    expect(metadata).not.toHaveProperty('timestamp')
    expect(metadata['traceId']).toBe('11111111111111111111111111111111')
    expect(typeof metadata['duration']).toBe('number')
  })

  it('keeps the wrapped span processor path when console filtering suppresses output', () => {
    const wrappedOnEndSpy = vi.spyOn(BatchSpanProcessor.prototype, 'onEnd')
    const processor = logfireSpanProcessor({ minLevel: 'warning' })
    const span = makeSpan({ 'logfire.level_num': Level.Debug })

    processor.onEnd(span)

    expect(logSpy).not.toHaveBeenCalled()
    expect(wrappedOnEndSpy).toHaveBeenCalledWith(span)
  })

  it('rejects invalid console min levels before creating the processor', () => {
    expect(() => logfireSpanProcessor({ minLevel: 'warn' as never })).toThrow('Invalid console.minLevel')
  })
})
