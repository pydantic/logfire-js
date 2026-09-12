/// <reference types="@cloudflare/workers-types/experimental" />

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vitest } from 'vitest'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { instrumentD1 } from '../../src/instrumentation/d1'

const exporter = new InMemorySpanExporter()

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

trace.setGlobalTracerProvider(provider)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

const batchMock = vitest.fn<() => Promise<D1Result[]>>()
const database = { batch: batchMock } as unknown as D1Database

function emptyMeta(): D1Meta {
  return {
    changed_db: false,
    changes: 0,
    duration: 1,
    last_row_id: 0,
    rows_read: 0,
    rows_written: 0,
    size_after: 0,
  } as unknown as D1Meta
}

function statements(): D1PreparedStatement[] {
  return [
    { params: [], statement: 'select 1' },
    { params: [], statement: 'select 2' },
  ] as unknown as D1PreparedStatement[]
}

beforeEach(() => {
  exporter.reset()
  vitest.resetAllMocks()
})

describe('D1 batch instrumentation', () => {
  it('records a span per statement on success', async () => {
    batchMock.mockResolvedValue([
      { meta: emptyMeta(), results: [], success: true },
      { meta: emptyMeta(), results: [], success: true },
    ] as unknown as D1Result[])

    const instrument = instrumentD1(database, 'my-db')
    await instrument.batch(statements())

    const spans = exporter.getFinishedSpans()
    const querySpans = spans.filter((span) => span.name === 'my-db batch > query')
    expect(querySpans).toHaveLength(2)
    expect(querySpans.map((span) => span.attributes['db.query.text'])).toEqual(['select 1', 'select 2'])
  })

  it('marks every statement span as an error when the batch rejects', async () => {
    const error = new Error('batch failed')
    batchMock.mockRejectedValue(error)

    const instrument = instrumentD1(database, 'my-db')
    await expect(instrument.batch(statements())).rejects.toBe(error)

    const spans = exporter.getFinishedSpans()
    const parent = spans.find((span) => span.name === 'my-db batch')
    const querySpans = spans.filter((span) => span.name === 'my-db batch > query')

    expect(parent?.status.code).toBe(SpanStatusCode.ERROR)
    expect(querySpans).toHaveLength(2)
    for (const span of querySpans) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
    }
  })
})
