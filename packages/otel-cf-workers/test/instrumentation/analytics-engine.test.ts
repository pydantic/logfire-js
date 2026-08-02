/// <reference types="@cloudflare/workers-types/experimental" />

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vitest } from 'vitest'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { AEAttributes, instrumentAnalyticsEngineDataset } from '../../src/instrumentation/analytics-engine'

const exporter = new InMemorySpanExporter()

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

trace.setGlobalTracerProvider(provider)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

const dataset = {
  writeDataPoint: vitest.fn<() => Promise<void>>().mockResolvedValue(undefined),
} as unknown as AnalyticsEngineDataset

// The Workers type declares `writeDataPoint` as returning void, but the instrumented proxy is
// async, so the tests await it through this narrower view.
type AsyncDataset = { writeDataPoint: (point: AnalyticsEngineDataPoint) => Promise<void> }

function instrumentAsync(name: string): AsyncDataset {
  return instrumentAnalyticsEngineDataset(dataset, name) as unknown as AsyncDataset
}

beforeEach(() => {
  exporter.reset()
  vitest.resetAllMocks()
})

describe('Analytics Engine attributes', () => {
  it('handles partial data points without optional arrays', () => {
    expect(AEAttributes.writeDataPoint([{}], undefined)).toEqual({
      'db.cf.ae.indexes': 0,
      'db.cf.ae.doubles': 0,
      'db.cf.ae.blobs': 0,
    })
  })

  it('records provided data point array counts', () => {
    expect(AEAttributes.writeDataPoint([{ indexes: ['index'], doubles: [1, 2], blobs: ['blob'] }], undefined)).toEqual({
      'db.cf.ae.indexes': 1,
      'db.cf.ae.index': 'index',
      'db.cf.ae.doubles': 2,
      'db.cf.ae.blobs': 1,
    })
  })
})

describe('Analytics Engine instrumentation', () => {
  it('ends the span for a successful write', async () => {
    const instrument = instrumentAsync('my-dataset')
    await expect(instrument.writeDataPoint({ blobs: ['b'], doubles: [1], indexes: ['idx'] })).resolves.toBe(undefined)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('Analytics Engine my-dataset writeDataPoint')
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET)
    expect(spans[0]?.attributes['db.cf.ae.indexes']).toBe(1)
  })

  it('ends the span and records the error when the write rejects', async () => {
    const error = new Error('write failed')
    ;(dataset.writeDataPoint as ReturnType<typeof vitest.fn<() => Promise<void>>>).mockRejectedValue(error)

    const instrument = instrumentAsync('my-dataset')
    await expect(instrument.writeDataPoint({ indexes: ['idx'] })).rejects.toBe(error)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('Analytics Engine my-dataset writeDataPoint')
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(spans[0]?.events.map((event) => event.name)).toEqual(['exception'])
    expect(spans[0]?.events[0]?.attributes?.['exception.message']).toBe('write failed')
  })
})
