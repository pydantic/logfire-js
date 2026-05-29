import type { Context, Span } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions'
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
import defaultExport, { info, Level, reportError, span, startPendingSpan, withSettings, withTags } from './index'
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

describe('reportError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('preserves legacy attributes argument and error behavior', () => {
    const error = new Error('legacy')

    reportError('Legacy error', error, { path: '/users' })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual([])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Error)
    expect(attributes[ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY]).toEqual(expect.any(String))
    expect(attributes[ATTR_EXCEPTION_MESSAGE]).toBe('legacy')
    expect(attributes[ATTR_EXCEPTION_STACKTRACE]).toBe(error.stack)
    expect(attributes['path']).toBe('/users')
    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: legacy' })
  })

  test('applies fourth-argument tags', () => {
    reportError('Tagged error', new Error('tagged'), { path: '/users' }, { tags: ['api', 'db'] })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['api', 'db'])
    expect(attributes['path']).toBe('/users')
  })

  test('uses fourth-argument parentSpan', () => {
    const parentSpan = mocks.makeSpan({ startTime: [100, 0] })

    reportError('Child error', new Error('child'), {}, { parentSpan: parentSpan as unknown as Span })

    expect(mocks.setSpan).toHaveBeenCalledWith(mocks.activeContext, parentSpan)
    expect(mocks.tracerMock.startSpan.mock.calls[0]?.[2]).toBe(mocks.setSpan.mock.results[0]?.value)
  })

  test('accepts a thrown string without fingerprinting', () => {
    reportError('String error', 'oops', { path: '/users' })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTR_EXCEPTION_MESSAGE]).toBe('oops')
    expect(attributes).not.toHaveProperty(ATTR_EXCEPTION_STACKTRACE)
    expect(attributes).not.toHaveProperty(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY)
    expect(attributes['path']).toBe('/users')
    expect(spanMock.recordException).toHaveBeenCalledWith('oops')
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: oops' })
  })

  test('accepts null, undefined, and plain object values without throwing', () => {
    const values = [null, undefined, { code: 'E_OBJECT' }]

    for (const value of values) {
      expect(() => {
        reportError('Unknown error', value)
      }).not.toThrow()
    }

    expect(mocks.tracerMock.startSpan).toHaveBeenCalledTimes(3)
    expect(spanMock.recordException).toHaveBeenNthCalledWith(1, 'null')
    expect(spanMock.recordException).toHaveBeenNthCalledWith(2, 'undefined')
    expect(spanMock.recordException).toHaveBeenNthCalledWith(3, '[object Object]')
  })

  test('default export exposes the updated reportError function', () => {
    const defaultReportError = Object.getOwnPropertyDescriptor(defaultExport, 'reportError')?.value as typeof reportError

    expect(defaultReportError).toBe(reportError)
    expect(() => {
      defaultReportError('Default export error', 'oops')
    }).not.toThrow()
  })
})

describe('scoped clients', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('withTags applies tags to log helpers', () => {
    withTags('user', 'db').info('Loaded user {id}', { id: 1 })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['user', 'db'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Info)
    expect(attributes[ATTRIBUTES_SPAN_TYPE_KEY]).toBe('log')
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('scoped and per-call tags merge with stable deduplication', () => {
    withTags('a', 'b').info('Tagged event', {}, { tags: ['b', 'c', 'a'] })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['a', 'b', 'c'])
  })

  test('nested clients accumulate tags and scoped level applies to log()', () => {
    const scoped = withTags('a', 'b')
      .withSettings({ level: Level.Warning, tags: ['b', 'c'] })
      .withTags('c', 'd')

    scoped.log('Nested event', {}, { tags: ['a', 'e'] })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
  })

  test('level-specific helpers override scoped level', () => {
    withSettings({ level: Level.Warning }).info('Info event')

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Info)
  })

  test('per-call level overrides scoped level for startSpan()', () => {
    withSettings({ level: Level.Warning, tags: ['scope'] }).startSpan('Manual span', {}, { level: Level.Error, tags: ['call'] })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'call'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Error)
    expect(attributes[ATTRIBUTES_SPAN_TYPE_KEY]).toBe('span')
  })

  test('scoped settings apply to startPendingSpan() real and pending spans', () => {
    const startTime: [number, number] = [123, 456]
    const realSpan = mocks.makeSpan({ startTime })
    const pendingSpan = mocks.makeSpan({ startTime })
    mocks.startSpanResults.push(realSpan, pendingSpan)

    withSettings({ level: Level.Warning, tags: ['scope'] }).startPendingSpan('Pending span', {}, { tags: ['call'] })

    const realAttributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    const pendingAttributes = (mocks.tracerMock.startSpan.mock.calls[1]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(realAttributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'call'])
    expect(realAttributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
    expect(pendingAttributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'call'])
    expect(pendingAttributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
    expect(pendingAttributes[ATTRIBUTES_SPAN_TYPE_KEY]).toBe('pending_span')
    expect(pendingSpan.end).toHaveBeenCalledWith(startTime)
  })

  test('scoped settings apply to object-style span()', () => {
    const result = withSettings({ level: Level.Warning, tags: ['scope'] }).span('Scoped active span {id}', {
      attributes: { id: 1 },
      callback: () => 'ok',
      tags: ['call'],
    })

    expect(result).toBe('ok')
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'call'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('scoped settings apply to positional span()', () => {
    const result = withTags('scope').span('Positional active span {id}', { id: 1 }, { tags: ['call'] }, () => 'ok')

    expect(result).toBe('ok')
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'call'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Info)
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('scoped tags apply to reportError without changing its public arguments', () => {
    const error = new Error('boom')

    withTags('scope').reportError('Caught error', error, { job: 'sync' })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Error)
    expect(attributes[ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY]).toEqual(expect.any(String))
    expect(attributes[ATTR_EXCEPTION_MESSAGE]).toBe('boom')
    expect(attributes['job']).toBe('sync')
    expect(spanMock.recordException).toHaveBeenCalledWith(error)
  })

  test('scoped reportError tags merge with fourth-argument tags and keep error level', () => {
    const error = new Error('boom')

    withSettings({ level: Level.Warning, tags: ['scope', 'shared'] }).reportError('Caught error', error, {}, { tags: ['shared', 'call'] })

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'shared', 'call'])
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Error)
  })

  test('top-level and default exports expose scoped client helpers', () => {
    const defaultWithTags = Object.getOwnPropertyDescriptor(defaultExport, 'withTags')?.value as typeof withTags
    const defaultWithSettings = Object.getOwnPropertyDescriptor(defaultExport, 'withSettings')?.value as typeof withSettings

    expect(defaultWithTags).toBe(withTags)
    expect(defaultWithSettings).toBe(withSettings)
    expect(typeof defaultWithTags('default').info).toBe('function')
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
