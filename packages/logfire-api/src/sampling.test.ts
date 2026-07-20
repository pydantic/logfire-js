/* eslint-disable @typescript-eslint/unbound-method */
import type { IdGenerator, ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api'
import { describe, expect, test, vi } from 'vite-plus/test'

import { ATTRIBUTES_LEVEL_KEY, ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { PendingSpanProcessor } from './PendingSpanProcessor'
import { setPendingSpanSuppressed } from './pendingSpanSuppression'
import { checkTraceIdRatio, levelOrDuration, SpanLevel } from './sampling'
import type { TailSamplingSpanInfo } from './sampling'
import { TailSamplingProcessor } from './TailSamplingProcessor'

describe('SpanLevel', () => {
  test('fromSpan reads logfire.level_num attribute', () => {
    const span = { attributes: { [ATTRIBUTES_LEVEL_KEY]: 17 } } as unknown as ReadableSpan
    const level = SpanLevel.fromSpan(span)
    expect(level.number).toBe(17)
    expect(level.name).toBe('error')
  })

  test('fromSpan defaults to info when attribute is missing', () => {
    const span = { attributes: {} } as unknown as ReadableSpan
    const level = SpanLevel.fromSpan(span)
    expect(level.number).toBe(9)
    expect(level.name).toBe('info')
  })

  test('name returns undefined for non-standard level numbers', () => {
    const level = new SpanLevel(42)
    expect(level.name).toBeUndefined()
  })

  test('comparison methods work correctly', () => {
    const level = new SpanLevel(10) // notice

    expect(level.gte('notice')).toBe(true)
    expect(level.gte('warning')).toBe(false)
    expect(level.gt('info')).toBe(true)
    expect(level.gt('notice')).toBe(false)
    expect(level.lte('notice')).toBe(true)
    expect(level.lte('info')).toBe(false)
    expect(level.lt('warning')).toBe(true)
    expect(level.lt('notice')).toBe(false)
  })
})

describe('checkTraceIdRatio', () => {
  test('rate 1.0 always returns true', () => {
    expect(checkTraceIdRatio('00000000000000000000000000000000', 1.0)).toBe(true)
    expect(checkTraceIdRatio('ffffffffffffffffffffffffffffffff', 1.0)).toBe(true)
  })

  test('rate 0.0 always returns false', () => {
    expect(checkTraceIdRatio('00000000000000000000000000000000', 0.0)).toBe(false)
    expect(checkTraceIdRatio('ffffffffffffffffffffffffffffffff', 0.0)).toBe(false)
  })

  test('deterministic for the same trace ID', () => {
    const traceId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
    const result1 = checkTraceIdRatio(traceId, 0.5)
    const result2 = checkTraceIdRatio(traceId, 0.5)
    expect(result1).toBe(result2)
  })

  test('all-zeros trace ID is always sampled at any positive rate', () => {
    expect(checkTraceIdRatio('00000000000000000000000000000000', 0.001)).toBe(true)
  })
})

describe('levelOrDuration', () => {
  test('returns sampling options with default thresholds', () => {
    const options = levelOrDuration()
    expect(options.head).toBeUndefined()
    expect(options.tail).toBeDefined()
  })

  test('tail callback returns 1.0 for spans at or above notice level', () => {
    const { tail } = levelOrDuration()
    const spanInfo = {
      context: null,
      duration: 0,
      event: 'start' as const,
      level: new SpanLevel(10), // notice
      span: {} as ReadableSpan,
    }
    expect(tail?.(spanInfo)).toBe(1.0)
  })

  test('tail callback returns 1.0 for spans exceeding duration threshold', () => {
    const { tail } = levelOrDuration()
    const spanInfo = {
      context: null,
      duration: 6.0,
      event: 'end' as const,
      level: new SpanLevel(9), // info (below notice)
      span: {} as ReadableSpan,
    }
    expect(tail?.(spanInfo)).toBe(1.0)
  })

  test('tail callback returns backgroundRate for non-matching spans', () => {
    const { tail } = levelOrDuration({ backgroundRate: 0.1 })
    const spanInfo = {
      context: null,
      duration: 1.0,
      event: 'start' as const,
      level: new SpanLevel(9), // info
      span: {} as ReadableSpan,
    }
    expect(tail?.(spanInfo)).toBe(0.1)
  })

  test('respects custom thresholds', () => {
    const { tail } = levelOrDuration({ durationThreshold: 2.0, levelThreshold: 'error' })
    const noticeSpan = {
      context: null,
      duration: 1.0,
      event: 'start' as const,
      level: new SpanLevel(10), // notice — below error
      span: {} as ReadableSpan,
    }
    expect(tail?.(noticeSpan)).toBe(0.0)

    const errorSpan = { ...noticeSpan, level: new SpanLevel(17) }
    expect(tail?.(errorSpan)).toBe(1.0)

    const longSpan = { ...noticeSpan, duration: 2.5 }
    expect(tail?.(longSpan)).toBe(1.0)
  })

  test('passes through head option', () => {
    const options = levelOrDuration({ head: 0.5 })
    expect(options.head).toBe(0.5)
  })
})

// --- TailSamplingProcessor tests ---

type TestSpan = ReadableSpan &
  Span & {
    setRecording(recording: boolean): void
  }

function makeSpan(options: {
  attributes?: Record<string, unknown>
  endTime?: [number, number]
  name?: string
  parentSpanContext?: object
  recording?: boolean
  spanId?: string
  startTime?: [number, number]
  traceId?: string
}): TestSpan {
  const traceId = options.traceId ?? 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0'
  const spanId = options.spanId ?? '1234567890abcdef'
  let recording = options.recording ?? true
  return {
    attributes: options.attributes ?? {},
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    duration: [0, 0],
    ended: !recording,
    endTime: options.endTime ?? [0, 0],
    events: [],
    instrumentationScope: { name: 'test-scope' },
    isRecording: () => recording,
    kind: SpanKind.INTERNAL,
    links: [],
    name: options.name ?? options.spanId ?? 'test span',
    parentSpanContext: options.parentSpanContext,
    resource: { attributes: {} },
    setRecording: (nextRecording: boolean) => {
      recording = nextRecording
    },
    spanContext: () => ({ isRemote: false, spanId, traceFlags: TraceFlags.SAMPLED, traceId }),
    startTime: options.startTime ?? [1000, 0],
    status: { code: SpanStatusCode.UNSET },
  } as unknown as TestSpan
}

function makeProcessor(): SpanProcessor & { calls: { event: string; span: unknown }[] } {
  const calls: { event: string; span: unknown }[] = []
  return {
    calls,
    forceFlush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onEnd: vi.fn<(span: ReadableSpan) => void>((span) => {
      calls.push({ event: 'end', span })
    }),
    onStart: vi.fn<(span: Span) => void>((span) => {
      calls.push({ event: 'start', span })
    }),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

function makeIdGenerator(): IdGenerator {
  let spanId = 1000
  return {
    generateSpanId: () => {
      spanId++
      return spanId.toString(16).padStart(16, '0')
    },
    generateTraceId: () => '11111111111111111111111111111111',
  }
}

function getPendingSpanNames(calls: { event: string; span: unknown }[]): string[] {
  return calls
    .filter(({ event, span }) => event === 'end' && (span as ReadableSpan).attributes[ATTRIBUTES_SPAN_TYPE_KEY] === 'pending_span')
    .map(({ span }) => (span as ReadableSpan).name)
}

describe('TailSamplingProcessor', () => {
  test('buffers spans and flushes when tail callback returns 1.0', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 1.0)

    const root = makeSpan({ attributes: { [ATTRIBUTES_LEVEL_KEY]: 9 }, startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    expect(downstream.calls).toHaveLength(1)
    expect(downstream.calls[0]).toEqual({ event: 'start', span: root })
  })

  test('buffers spans and discards when root ends without meeting criteria', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0)

    const root = makeSpan({ startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(0)

    const child = makeSpan({ parentSpanContext: { spanId: '1234567890abcdef' }, spanId: 'child00000000000', startTime: [1001, 0] })
    processor.onStart(child, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(0)

    processor.onEnd(child as unknown as ReadableSpan)
    expect(downstream.calls).toHaveLength(0)

    processor.onEnd(root as unknown as ReadableSpan)
    expect(downstream.calls).toHaveLength(0)
  })

  test('flushes buffered spans when a later span meets criteria', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, (info) => {
      return info.level.gte('error') ? 1.0 : 0.0
    })

    const root = makeSpan({ startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(0)

    // Child span with error level triggers flush on onStart
    const child = makeSpan({
      attributes: { [ATTRIBUTES_LEVEL_KEY]: 17 },
      parentSpanContext: { spanId: '1234567890abcdef' },
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(child, ROOT_CONTEXT)
    // Flush replays root.onStart + child.onStart
    expect(downstream.calls).toEqual([
      { event: 'start', span: root },
      { event: 'start', span: child },
    ])

    // After flush, subsequent spans pass through directly
    processor.onEnd(child as unknown as ReadableSpan)
    expect(downstream.calls).toHaveLength(3)

    processor.onEnd(root as unknown as ReadableSpan)
    expect(downstream.calls).toHaveLength(4)
    expect(downstream.calls[3]).toEqual({ event: 'end', span: root })
  })

  test('passes through spans after buffer is flushed', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 1.0)

    const root = makeSpan({ startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    // Immediately flushed since tail returns 1.0
    expect(downstream.calls).toHaveLength(1)

    // Subsequent spans for this trace should pass through
    const child = makeSpan({
      parentSpanContext: { spanId: '1234567890abcdef' },
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(child, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(2)

    processor.onEnd(child as unknown as ReadableSpan)
    expect(downstream.calls).toHaveLength(3)
  })

  test('emits pending spans for accepted traces and later children accepted from onStart', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(
      downstream,
      (info) => (info.event === 'start' && info.span.name === 'child a' ? 1.0 : 0.0),
      { deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }) }
    )

    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(0)

    const childA = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'child a',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(childA, ROOT_CONTEXT)
    expect(getPendingSpanNames(downstream.calls)).toEqual(['root', 'child a'])

    const childB = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'child b',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000001',
      startTime: [1002, 0],
    })
    processor.onStart(childB, ROOT_CONTEXT)
    expect(getPendingSpanNames(downstream.calls)).toEqual(['root', 'child a', 'child b'])
  })

  test('emits pending spans when a duration-threshold tail callback accepts a deferred trace', () => {
    const downstream = makeProcessor()
    const tail = levelOrDuration({ durationThreshold: 2.0 }).tail
    if (tail === undefined) {
      throw new Error('expected tail sampler')
    }
    const processor = new TailSamplingProcessor(downstream, tail, {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    const child = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'slow child',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1003, 0],
    })
    processor.onStart(child, ROOT_CONTEXT)

    expect(getPendingSpanNames(downstream.calls)).toEqual(['root', 'slow child'])
  })

  test('flushes when the ending root span crosses the duration threshold', () => {
    const downstream = makeProcessor()
    const tail = levelOrDuration({ durationThreshold: 2.0 }).tail
    if (tail === undefined) {
      throw new Error('expected tail sampler')
    }
    const processor = new TailSamplingProcessor(downstream, tail)

    const root = makeSpan({ endTime: [1010, 0], name: 'slow root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(0)

    root.setRecording(false)
    processor.onEnd(root)
    expect(downstream.calls).toEqual([
      { event: 'start', span: root },
      { event: 'end', span: root },
    ])
  })

  test('flushes when an ending child span crosses the duration threshold', () => {
    const downstream = makeProcessor()
    const tail = levelOrDuration({ durationThreshold: 2.0 }).tail
    if (tail === undefined) {
      throw new Error('expected tail sampler')
    }
    const processor = new TailSamplingProcessor(downstream, tail)

    const root = makeSpan({ name: 'root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    const child = makeSpan({
      endTime: [1005, 0],
      name: 'slow child',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(child, ROOT_CONTEXT)
    expect(downstream.calls).toHaveLength(0)

    child.setRecording(false)
    processor.onEnd(child)
    expect(downstream.calls).toEqual([
      { event: 'start', span: root },
      { event: 'start', span: child },
      { event: 'end', span: child },
    ])
  })

  test('emits pending spans for later children after acceptance from onEnd', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, (info) => (info.event === 'end' && info.span.name === 'child a' ? 1.0 : 0.0), {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    const childA = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'child a',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(childA, ROOT_CONTEXT)
    childA.setRecording(false)
    processor.onEnd(childA)
    expect(getPendingSpanNames(downstream.calls)).toEqual(['root'])
    expect(downstream.calls).toContainEqual({ event: 'end', span: childA })

    const childB = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'child b',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000001',
      startTime: [1002, 0],
    })
    processor.onStart(childB, ROOT_CONTEXT)
    expect(getPendingSpanNames(downstream.calls)).toEqual(['root', 'child b'])
  })

  test('does not emit pending spans for dropped traces or their late children', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0, {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    root.setRecording(false)
    processor.onEnd(root)
    expect(downstream.calls).toHaveLength(0)

    const lateChild = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'late child',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(lateChild, ROOT_CONTEXT)
    expect(downstream.calls).toEqual([{ event: 'start', span: lateChild }])
    expect(getPendingSpanNames(downstream.calls)).toEqual([])
  })

  test('does not call the tail callback for manual pending placeholders', () => {
    const downstream = makeProcessor()
    const tail = vi.fn<() => number>(() => 0.0)
    const processor = new TailSamplingProcessor(downstream, tail)
    const pendingRoot = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span' },
      name: 'manual pending',
      startTime: [1000, 0],
    })

    processor.onStart(pendingRoot, ROOT_CONTEXT)
    processor.onEnd(pendingRoot)

    expect(tail).not.toHaveBeenCalled()
    expect(downstream.calls).toHaveLength(0)
  })

  test('exports manual pending placeholders when the real trace is accepted', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, (info) =>
      info.event === 'end' && info.span.name === 'manual root' ? 1.0 : 0.0
    )
    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'manual root', startTime: [1000, 0] })
    const pendingRoot = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span' },
      name: 'manual root',
      parentSpanContext: root.spanContext(),
      spanId: 'pending000000000',
      startTime: [1000, 0],
    })

    processor.onStart(root, ROOT_CONTEXT)
    processor.onStart(pendingRoot, ROOT_CONTEXT)
    processor.onEnd(pendingRoot)
    processor.onEnd(root)

    expect(getPendingSpanNames(downstream.calls)).toEqual(['manual root'])
  })

  test('accepts a tail-buffered trace from a real manual child but not its pending placeholder', () => {
    const downstream = makeProcessor()
    const tail = vi.fn<(info: TailSamplingSpanInfo) => number>((info) =>
      info.event === 'start' && info.span.name === 'manual child' ? 1.0 : 0.0
    )
    const processor = new TailSamplingProcessor(downstream, tail)
    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'root', startTime: [1000, 0] })
    const child = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'manual child',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    const pendingChild = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span' },
      name: 'manual child',
      parentSpanContext: child.spanContext(),
      spanId: 'pending000000000',
      startTime: [1001, 0],
    })

    processor.onStart(root, ROOT_CONTEXT)
    processor.onStart(child, setPendingSpanSuppressed(ROOT_CONTEXT))
    processor.onStart(pendingChild, ROOT_CONTEXT)
    processor.onEnd(pendingChild)

    expect(tail.mock.calls.map(([info]) => info.span.name)).toEqual(['root', 'manual child'])
    expect(getPendingSpanNames(downstream.calls)).toEqual(['manual child'])
  })

  test('drops manual pending placeholders when the real trace is dropped', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0)
    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'manual root', startTime: [1000, 0] })
    const pendingRoot = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span' },
      name: 'manual root',
      parentSpanContext: root.spanContext(),
      spanId: 'pending000000000',
      startTime: [1000, 0],
    })

    processor.onStart(root, ROOT_CONTEXT)
    processor.onStart(pendingRoot, ROOT_CONTEXT)
    processor.onEnd(pendingRoot)
    processor.onEnd(root)

    expect(downstream.calls).toHaveLength(0)
  })

  test('does not duplicate manual pending placeholders when deferred pending processing replays buffered starts', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(
      downstream,
      (info) => (info.event === 'end' && info.span.name === 'manual root' ? 1.0 : 0.0),
      { deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }) }
    )
    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'manual root', startTime: [1000, 0] })
    const pendingRoot = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span' },
      name: 'manual root',
      parentSpanContext: root.spanContext(),
      spanId: 'pending000000000',
      startTime: [1000, 0],
    })

    processor.onStart(root, setPendingSpanSuppressed(ROOT_CONTEXT))
    processor.onStart(pendingRoot, ROOT_CONTEXT)
    processor.onEnd(pendingRoot)
    processor.onEnd(root)

    expect(getPendingSpanNames(downstream.calls)).toEqual(['manual root'])
  })

  test('does not emit pending spans for children that start after accepted root end', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 1.0, {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    const root = makeSpan({ attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' }, name: 'root', startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)
    expect(getPendingSpanNames(downstream.calls)).toEqual(['root'])

    root.setRecording(false)
    processor.onEnd(root)

    const lateChild = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'span' },
      name: 'late child',
      parentSpanContext: root.spanContext(),
      spanId: 'child00000000000',
      startTime: [1001, 0],
    })
    processor.onStart(lateChild, ROOT_CONTEXT)
    expect(getPendingSpanNames(downstream.calls)).toEqual(['root'])
    expect(downstream.calls[downstream.calls.length - 1]).toEqual({ event: 'start', span: lateChild })
  })

  test('applies pending-span skip rules through deferred replay', () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 1.0, {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    const logSpan = makeSpan({
      attributes: { [ATTRIBUTES_SPAN_TYPE_KEY]: 'log' },
      name: 'log event',
      startTime: [1000, 0],
    })
    processor.onStart(logSpan, ROOT_CONTEXT)

    expect(downstream.calls).toEqual([{ event: 'start', span: logSpan }])
    expect(getPendingSpanNames(downstream.calls)).toEqual([])
  })

  test('computes duration from trace start', () => {
    const downstream = makeProcessor()
    const durations: number[] = []
    const processor = new TailSamplingProcessor(downstream, (info) => {
      durations.push(info.duration)
      return 0.0
    })

    const root = makeSpan({ startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    const child = makeSpan({
      parentSpanContext: { spanId: '1234567890abcdef' },
      spanId: 'child00000000000',
      startTime: [1003, 500000000],
    })
    processor.onStart(child, ROOT_CONTEXT)

    expect(durations[0]).toBe(0) // root start - trace start = 0
    expect(durations[1]).toBeCloseTo(3.5) // child start is 3.5s after root start
  })

  test('forceFlush delegates to wrapped processor', async () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0)
    await processor.forceFlush()
    expect(downstream.forceFlush).toHaveBeenCalled()
  })

  test('forceFlush with deferred pending processor does not double-flush the wrapped processor', async () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0, {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    await processor.forceFlush()

    expect(downstream.forceFlush).toHaveBeenCalledTimes(1)
  })

  test('shutdown clears buffers and delegates', async () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0)

    const root = makeSpan({ startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    await processor.shutdown()
    expect(downstream.shutdown).toHaveBeenCalled()
  })

  test('shutdown with deferred pending processor does not double-shutdown the wrapped processor', async () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0, {
      deferredProcessor: new PendingSpanProcessor(downstream, { idGenerator: makeIdGenerator() }),
    })

    await processor.shutdown()

    expect(downstream.shutdown).toHaveBeenCalledTimes(1)
  })
})
