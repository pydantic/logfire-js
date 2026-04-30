/* eslint-disable @typescript-eslint/unbound-method */
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ROOT_CONTEXT } from '@opentelemetry/api'
import { describe, expect, test, vi } from 'vite-plus/test'

import { ATTRIBUTES_LEVEL_KEY } from './constants'
import { checkTraceIdRatio, levelOrDuration, SpanLevel } from './sampling'
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

function makeSpan(options: {
  attributes?: Record<string, unknown>
  parentSpanContext?: object
  spanId?: string
  startTime?: [number, number]
  traceId?: string
}): ReadableSpan & Span {
  const traceId = options.traceId ?? 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0'
  const spanId = options.spanId ?? '1234567890abcdef'
  return {
    attributes: options.attributes ?? {},
    parentSpanContext: options.parentSpanContext,
    spanContext: () => ({ isRemote: false, spanId, traceFlags: 1, traceId }),
    startTime: options.startTime ?? [1000, 0],
  } as unknown as ReadableSpan & Span
}

function makeProcessor(): SpanProcessor & { calls: { event: string; span: unknown }[] } {
  const calls: { event: string; span: unknown }[] = []
  return {
    calls,
    forceFlush: vi.fn().mockResolvedValue(undefined),
    onEnd: vi.fn((span: ReadableSpan) => calls.push({ event: 'end', span })),
    onStart: vi.fn((span: Span) => calls.push({ event: 'start', span })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
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

  test('shutdown clears buffers and delegates', async () => {
    const downstream = makeProcessor()
    const processor = new TailSamplingProcessor(downstream, () => 0.0)

    const root = makeSpan({ startTime: [1000, 0] })
    processor.onStart(root, ROOT_CONTEXT)

    await processor.shutdown()
    expect(downstream.shutdown).toHaveBeenCalled()
  })
})
