import type { Context, Span } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY,
  ATTRIBUTES_LEVEL_KEY,
  ATTRIBUTES_MESSAGE_KEY,
  ATTRIBUTES_MESSAGE_TEMPLATE_KEY,
  ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY,
  ATTRIBUTES_SPAN_TYPE_KEY,
  ATTRIBUTES_TAGS_KEY,
  INVALID_SPAN_ID,
} from './constants'
import defaultExport, { info, span, startPendingSpan } from './index'
import { isPendingSpanSuppressed } from './pendingSpanSuppression'

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const mocks = vi.hoisted(() => {
  interface MockContext {
    getValue(key: symbol): unknown
    id: string
    setValue(key: symbol, value: unknown): MockContext
    values: Map<symbol, unknown>
  }

  interface MockSpan {
    attributes: Record<string, unknown>
    end: ReturnType<typeof vi.fn<(endTime?: unknown) => void>>
    isRecording: ReturnType<typeof vi.fn<() => boolean>>
    parentSpanContext?: { spanId: string }
    recordException: ReturnType<typeof vi.fn<(exception: unknown) => void>>
    setAttribute: ReturnType<typeof vi.fn<(key: string, value: unknown) => void>>
    setStatus: ReturnType<typeof vi.fn<(status: unknown) => void>>
    spanContext: ReturnType<typeof vi.fn<() => { spanId: string; traceId: string }>>
    startTime?: [number, number]
  }

  let contextId = 0

  function makeContext(values = new Map<symbol, unknown>()): MockContext {
    contextId++
    return {
      getValue: (key: symbol) => values.get(key),
      id: `context-${contextId.toString()}`,
      setValue: (key: symbol, value: unknown) => {
        const nextValues = new Map(values)
        nextValues.set(key, value)
        return makeContext(nextValues)
      },
      values,
    }
  }

  function makeSpan(options: { parentSpanId?: string; recording?: boolean; startTime?: [number, number] } = {}): MockSpan {
    return {
      attributes: {},
      end: vi.fn<(endTime?: unknown) => void>(),
      isRecording: vi.fn<() => boolean>(() => options.recording ?? true),
      ...(options.parentSpanId !== undefined ? { parentSpanContext: { spanId: options.parentSpanId } } : {}),
      recordException: vi.fn<(exception: unknown) => void>(),
      setAttribute: vi.fn<(key: string, value: unknown) => void>(),
      setStatus: vi.fn<(status: unknown) => void>(),
      spanContext: vi.fn<() => { spanId: string; traceId: string }>(() => ({
        spanId: 'real-span-id',
        traceId: '11111111111111111111111111111111',
      })),
      ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
    }
  }

  const activeContext = makeContext()
  const spanMock = makeSpan({ startTime: [1000, 0] })
  const startSpanResults: MockSpan[] = []

  const tracerMock = {
    startActiveSpan: vi.fn<(_name: string, _options: unknown, _context: unknown, fn: (s: MockSpan) => unknown) => unknown>(
      (_name, _options, _context, fn) => fn(spanMock)
    ),
    startSpan: vi.fn<(_name: string, _options?: unknown, _context?: MockContext) => MockSpan>(() => startSpanResults.shift() ?? spanMock),
  }

  return {
    activeContext,
    contextWith: vi.fn<() => unknown>(),
    makeSpan,
    reset() {
      startSpanResults.length = 0
      tracerMock.startActiveSpan.mockClear()
      tracerMock.startSpan.mockClear()
      spanMock.end.mockClear()
      spanMock.isRecording.mockClear()
      spanMock.recordException.mockClear()
      spanMock.setAttribute.mockClear()
      spanMock.setStatus.mockClear()
      spanMock.spanContext.mockClear()
    },
    setSpan: vi.fn<(ctx: MockContext, span: MockSpan) => MockContext>((ctx, span) => ctx.setValue(Symbol.for('otel-test-span'), span)),
    spanMock,
    startSpanResults,
    tracerMock,
  }
})

const { spanMock } = mocks

vi.mock('@opentelemetry/api', () => {
  return {
    context: {
      active: vi.fn<() => unknown>(() => mocks.activeContext),
      with: mocks.contextWith,
    },
    createContextKey: (description: string) => Symbol.for(description),
    SpanStatusCode: { ERROR: 2 },
    trace: {
      getTracer: vi.fn<() => typeof mocks.tracerMock>(() => mocks.tracerMock),
      setSpan: mocks.setSpan,
    },
  }
})

describe('info', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })
  test('formats the message with the passed attributes', () => {
    info('aha {i}', { i: 1 })
    const tracer = trace.getTracer('logfire')

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracer.startSpan).toBeCalledWith(
      'aha {i}',
      {
        attributes: {
          [ATTRIBUTES_LEVEL_KEY]: 9,
          [ATTRIBUTES_MESSAGE_KEY]: 'aha 1',
          [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: 'aha {i}',
          [ATTRIBUTES_SPAN_TYPE_KEY]: 'log',
          [ATTRIBUTES_TAGS_KEY]: [],
          i: 1,
        },
      },
      mocks.activeContext
    )
  })

  test('adds scrubbing details', () => {
    info('aha {i}', { i: 1, password: 'hunter' })
    const tracer = trace.getTracer('logfire')

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracer.startSpan).toBeCalledWith(
      'aha {i}',
      {
        attributes: {
          [ATTRIBUTES_LEVEL_KEY]: 9,
          [ATTRIBUTES_MESSAGE_KEY]: 'aha 1',
          [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: 'aha {i}',
          [ATTRIBUTES_SPAN_TYPE_KEY]: 'log',
          [ATTRIBUTES_TAGS_KEY]: [],
          i: 1,
          'logfire.json_schema': '{"properties":{"logfire.scrubbed":{"type":"array"}},"type":"object"}',
          'logfire.scrubbed': '[{"matched_substring":"password","path":["password"]}]',
          password: "[Scrubbed due to 'password']",
        },
      },
      mocks.activeContext
    )
  })
})

describe('span', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('sync callback succeeds - span ends normally', () => {
    const result = span('test {x}', { attributes: { x: 1 }, callback: () => 'ok' })

    expect(result).toBe('ok')
    expect(spanMock.end).toHaveBeenCalledOnce()
    expect(spanMock.recordException).not.toHaveBeenCalled()
    expect(spanMock.setStatus).not.toHaveBeenCalled()
  })

  test('sync callback throws Error - records exception and re-throws', () => {
    const error = new Error('boom')

    expect(() =>
      span('test {x}', {
        attributes: { x: 1 },
        callback: () => {
          throw error
        },
      })
    ).toThrow(error)

    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: boom' })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_LEVEL_KEY, 17)
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, expect.any(String))
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('sync callback throws string - records exception without fingerprint', () => {
    expect(() =>
      span('test', {
        callback: () => {
          // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
          throw 'oops'
        },
      })
    ).toThrow('oops')

    expect(spanMock.recordException).toHaveBeenCalledWith('oops')
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: oops' })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_LEVEL_KEY, 17)
    expect(spanMock.setAttribute).not.toHaveBeenCalledWith(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, expect.anything())
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('async callback resolves - span ends normally', async () => {
    const result = span('test', { callback: async () => Promise.resolve('async-ok') })
    await expect(result).resolves.toBe('async-ok')

    expect(spanMock.end).toHaveBeenCalledOnce()
    expect(spanMock.recordException).not.toHaveBeenCalled()
    expect(spanMock.setStatus).not.toHaveBeenCalled()
  })

  test('async callback rejects with Error - records exception', async () => {
    const error = new Error('async-boom')
    const result = span('test', { callback: async () => Promise.reject(error) })

    await expect(result).rejects.toThrow(error)

    // Allow microtask for the .then() handler to run
    await sleep(0)

    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: async-boom' })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_LEVEL_KEY, 17)
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, expect.any(String))
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('async callback rejects with string - records exception without fingerprint', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors, @typescript-eslint/prefer-promise-reject-errors
    const result = span('test', { callback: async () => Promise.reject('async-oops') })

    await expect(result).rejects.toBe('async-oops')

    await sleep(0)

    expect(spanMock.recordException).toHaveBeenCalledWith('async-oops')
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: async-oops' })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_LEVEL_KEY, 17)
    expect(spanMock.setAttribute).not.toHaveBeenCalledWith(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, expect.anything())
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('thenable callback result is returned untouched', () => {
    const then = vi.fn<() => void>()
    const lazyThenable = { then }

    const result = span('test', { callback: () => lazyThenable })

    expect(result).toBe(lazyThenable)
    expect(then).not.toHaveBeenCalled()
    expect(spanMock.end).toHaveBeenCalledOnce()
  })
})

describe('startPendingSpan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('starts a real span and emits one zero-duration pending placeholder', () => {
    const startTime: [number, number] = [123, 456]
    const realSpan = mocks.makeSpan({ parentSpanId: 'parent-span-id', startTime })
    const pendingSpan = mocks.makeSpan({ startTime })
    mocks.startSpanResults.push(realSpan, pendingSpan)

    const result = startPendingSpan('load {route}', { route: '/dashboard' }, { tags: ['ui'] })

    expect(result).toBe(realSpan)
    expect(mocks.tracerMock.startSpan).toHaveBeenCalledTimes(2)
    expect(mocks.contextWith).not.toHaveBeenCalled()

    const realStartCall = mocks.tracerMock.startSpan.mock.calls[0]
    expect(realStartCall?.[0]).toBe('load {route}')
    expect(realStartCall?.[1]).toEqual({
      attributes: {
        [ATTRIBUTES_LEVEL_KEY]: 9,
        [ATTRIBUTES_MESSAGE_KEY]: 'load /dashboard',
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: 'load {route}',
        [ATTRIBUTES_SPAN_TYPE_KEY]: 'span',
        [ATTRIBUTES_TAGS_KEY]: ['ui'],
        route: '/dashboard',
      },
    })
    const realStartContext = realStartCall?.[2] as unknown as Context
    expect(realStartContext).not.toBe(mocks.activeContext)
    expect(isPendingSpanSuppressed(realStartContext)).toBe(true)

    const pendingStartCall = mocks.tracerMock.startSpan.mock.calls[1]
    expect(pendingStartCall?.[0]).toBe('load {route}')
    expect(pendingStartCall?.[1]).toEqual({
      attributes: {
        [ATTRIBUTES_LEVEL_KEY]: 9,
        [ATTRIBUTES_MESSAGE_KEY]: 'load /dashboard',
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: 'load {route}',
        [ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY]: 'parent-span-id',
        [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span',
        [ATTRIBUTES_TAGS_KEY]: ['ui'],
        route: '/dashboard',
      },
      startTime,
    })
    expect(isPendingSpanSuppressed(pendingStartCall?.[2] as unknown as Context)).toBe(false)
    expect(mocks.setSpan).toHaveBeenCalledWith(mocks.activeContext, realSpan)
    expect(pendingSpan.end).toHaveBeenCalledWith(startTime)
  })

  test('skips placeholder emission when the real span is not recording', () => {
    const realSpan = mocks.makeSpan({ recording: false, startTime: [123, 456] })
    mocks.startSpanResults.push(realSpan)

    const result = startPendingSpan('load')

    expect(result).toBe(realSpan)
    expect(mocks.tracerMock.startSpan).toHaveBeenCalledTimes(1)
  })

  test('skips placeholder emission when SDK timing data is unavailable', () => {
    const realSpan = mocks.makeSpan()
    delete realSpan.startTime
    mocks.startSpanResults.push(realSpan)

    const result = startPendingSpan('load')

    expect(result).toBe(realSpan)
    expect(mocks.tracerMock.startSpan).toHaveBeenCalledTimes(1)
  })

  test('records an all-zero pending parent ID for root pending spans', () => {
    const startTime: [number, number] = [123, 456]
    const realSpan = mocks.makeSpan({ startTime })
    const pendingSpan = mocks.makeSpan({ startTime })
    mocks.startSpanResults.push(realSpan, pendingSpan)

    startPendingSpan('load')

    const pendingStartCall = mocks.tracerMock.startSpan.mock.calls[1]
    expect(pendingStartCall?.[1]).toMatchObject({
      attributes: {
        [ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY]: INVALID_SPAN_ID,
        [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span',
      },
      startTime,
    })
    expect(pendingSpan.end).toHaveBeenCalledWith(startTime)
  })

  test('supports parentSpan and _spanName options', () => {
    const startTime: [number, number] = [123, 456]
    const parentSpan = mocks.makeSpan({ startTime: [100, 0] })
    const realSpan = mocks.makeSpan({ startTime })
    const pendingSpan = mocks.makeSpan({ startTime })
    mocks.startSpanResults.push(realSpan, pendingSpan)

    startPendingSpan(
      'friendly {name}',
      { name: 'label' },
      { _spanName: 'stable-name', level: 13, parentSpan: parentSpan as unknown as Span }
    )

    expect(mocks.setSpan).toHaveBeenCalledWith(mocks.activeContext, parentSpan)
    expect(mocks.tracerMock.startSpan.mock.calls[0]?.[0]).toBe('stable-name')
    expect(mocks.tracerMock.startSpan.mock.calls[1]?.[0]).toBe('stable-name')
    expect(pendingSpan.end).toHaveBeenCalledWith(startTime)
  })

  test('does not export a callback-style pendingSpan helper', () => {
    expect('pendingSpan' in defaultExport).toBe(false)
  })
})
