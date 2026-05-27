/* eslint-disable @typescript-eslint/unbound-method */
import type { Attributes, HrTime, Link, SpanContext } from '@opentelemetry/api'
import type { IdGenerator, ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api'
import { describe, expect, test, vi } from 'vite-plus/test'

import { ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY, ATTRIBUTES_SAMPLE_RATE_KEY, ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { PendingSpanProcessor } from './PendingSpanProcessor'

const TRACE_ID = '11111111111111111111111111111111'
const SPAN_ID = '2222222222222222'
const PARENT_SPAN_ID = '3333333333333333'
const PENDING_SPAN_ID = '4444444444444444'

function makeIdGenerator(spanId = PENDING_SPAN_ID): IdGenerator {
  return {
    generateSpanId: () => spanId,
    generateTraceId: () => '55555555555555555555555555555555',
  }
}

function makeWrappedProcessor(): SpanProcessor {
  return {
    forceFlush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onEnd: vi.fn<(span: ReadableSpan) => void>(),
    onStart: vi.fn<(span: Span) => void>(),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

function getExportedSpan(processor: SpanProcessor): ReadableSpan {
  const call = vi.mocked(processor.onEnd).mock.calls[0]
  if (call === undefined) {
    throw new Error('expected wrapped processor onEnd call')
  }
  return call[0]
}

function makeSpan(
  options: {
    attributes?: Attributes
    events?: ReadableSpan['events']
    links?: Link[]
    parentSpanContext?: SpanContext
    recording?: boolean
    spanId?: string
    startTime?: HrTime
    traceFlags?: number
    traceId?: string
  } = {}
): Span {
  const traceId = options.traceId ?? TRACE_ID
  const spanContext: SpanContext = {
    isRemote: false,
    spanId: options.spanId ?? SPAN_ID,
    traceFlags: options.traceFlags ?? TraceFlags.SAMPLED,
    traceId,
  }
  const startTime = options.startTime ?? ([123, 456] as HrTime)
  const links = options.links ?? [
    {
      attributes: { linked: true },
      context: {
        spanId: '6666666666666666',
        traceFlags: TraceFlags.SAMPLED,
        traceId: '77777777777777777777777777777777',
      },
    },
  ]
  const events = options.events ?? [
    {
      attributes: { event: 'value' },
      name: 'event-name',
      time: [124, 0] as HrTime,
    },
  ]

  return {
    attributes: options.attributes ?? { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span', custom: 'value' },
    droppedAttributesCount: 1,
    droppedEventsCount: 2,
    droppedLinksCount: 3,
    duration: [0, 0] as HrTime,
    ended: false,
    endTime: [0, 0] as HrTime,
    events,
    instrumentationScope: { name: 'test-scope', version: '1.0.0' },
    isRecording: () => options.recording ?? true,
    kind: SpanKind.INTERNAL,
    links,
    name: 'real span',
    ...(options.parentSpanContext !== undefined ? { parentSpanContext: options.parentSpanContext } : {}),
    resource: { attributes: { 'service.name': 'test-service' } },
    spanContext: () => spanContext,
    startTime,
    status: { code: SpanStatusCode.OK, message: 'ok' },
  } as unknown as Span
}

describe('PendingSpanProcessor', () => {
  test('emits one synthetic pending span on normal span start', () => {
    const wrapped = makeWrappedProcessor()
    const processor = new PendingSpanProcessor(wrapped, { idGenerator: makeIdGenerator() })
    const parentSpanContext: SpanContext = {
      isRemote: true,
      spanId: PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      traceId: TRACE_ID,
    }
    const startTime: HrTime = [1000, 500]
    const realSpan = makeSpan({ parentSpanContext, startTime, traceFlags: TraceFlags.SAMPLED })

    processor.onStart(realSpan, ROOT_CONTEXT)

    expect(wrapped.onEnd).toHaveBeenCalledTimes(1)
    const pendingSpan = getExportedSpan(wrapped)
    expect(pendingSpan.name).toBe(realSpan.name)
    expect(pendingSpan.kind).toBe(realSpan.kind)
    expect(pendingSpan.resource).toBe(realSpan.resource)
    expect(pendingSpan.instrumentationScope).toBe(realSpan.instrumentationScope)
    expect(pendingSpan.links).toBe(realSpan.links)
    expect(pendingSpan.events).toBe(realSpan.events)
    expect(pendingSpan.status).toBe(realSpan.status)
    expect(pendingSpan.droppedAttributesCount).toBe(realSpan.droppedAttributesCount)
    expect(pendingSpan.droppedEventsCount).toBe(realSpan.droppedEventsCount)
    expect(pendingSpan.droppedLinksCount).toBe(realSpan.droppedLinksCount)
    expect(pendingSpan.startTime).toBe(startTime)
    expect(pendingSpan.endTime).toBe(startTime)
    expect(pendingSpan.duration).toEqual([0, 0])
    expect(pendingSpan.parentSpanContext).toEqual(realSpan.spanContext())
    expect(pendingSpan.spanContext()).toEqual({
      isRemote: false,
      spanId: PENDING_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      traceId: TRACE_ID,
    })
    expect(pendingSpan.attributes).toEqual({
      ...realSpan.attributes,
      [ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY]: PARENT_SPAN_ID,
      [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span',
    })
  })

  test('records an all-zero real parent ID for root spans', () => {
    const wrapped = makeWrappedProcessor()
    const processor = new PendingSpanProcessor(wrapped, { idGenerator: makeIdGenerator() })

    processor.onStart(makeSpan({ attributes: { custom: 'value' } }), ROOT_CONTEXT)

    const pendingSpan = getExportedSpan(wrapped)
    expect(pendingSpan.attributes[ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY]).toBe('0000000000000000')
    expect(pendingSpan.attributes[ATTRIBUTES_SPAN_TYPE_KEY]).toBe('pending_span')
  })

  test('skips log spans and already-pending spans', () => {
    const wrapped = makeWrappedProcessor()
    const processor = new PendingSpanProcessor(wrapped, { idGenerator: makeIdGenerator() })

    processor.onStart(makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'log' } }), ROOT_CONTEXT)
    processor.onStart(makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span' } }), ROOT_CONTEXT)

    expect(wrapped.onEnd).not.toHaveBeenCalled()
  })

  test('skips non-recording spans and unsampled contexts', () => {
    const wrapped = makeWrappedProcessor()
    const processor = new PendingSpanProcessor(wrapped, { idGenerator: makeIdGenerator() })

    processor.onStart(makeSpan({ recording: false }), ROOT_CONTEXT)
    processor.onStart(makeSpan({ traceFlags: TraceFlags.NONE }), ROOT_CONTEXT)

    expect(wrapped.onEnd).not.toHaveBeenCalled()
  })

  test('respects logfire sample-rate attributes', () => {
    const wrapped = makeWrappedProcessor()
    const processor = new PendingSpanProcessor(wrapped, { idGenerator: makeIdGenerator() })

    processor.onStart(
      makeSpan({
        attributes: { [ATTRIBUTES_SAMPLE_RATE_KEY]: 0, [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      }),
      ROOT_CONTEXT
    )
    expect(wrapped.onEnd).not.toHaveBeenCalled()

    processor.onStart(
      makeSpan({
        attributes: { [ATTRIBUTES_SAMPLE_RATE_KEY]: 1, [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      }),
      ROOT_CONTEXT
    )
    expect(wrapped.onEnd).toHaveBeenCalledTimes(1)
  })

  test('does not forward final spans or own lifecycle calls', async () => {
    const wrapped = makeWrappedProcessor()
    const processor = new PendingSpanProcessor(wrapped, { idGenerator: makeIdGenerator() })
    const finalSpan = makeSpan()

    processor.onEnd(finalSpan)
    await processor.forceFlush()
    await processor.shutdown()

    expect(wrapped.onEnd).not.toHaveBeenCalled()
    expect(wrapped.forceFlush).not.toHaveBeenCalled()
    expect(wrapped.shutdown).not.toHaveBeenCalled()
  })
})
