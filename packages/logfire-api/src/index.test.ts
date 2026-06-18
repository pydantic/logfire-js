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
  JSON_NULL_FIELDS_KEY,
  JSON_SCHEMA_KEY,
} from './constants'
import defaultExport, {
  configureLogfireApi,
  debug,
  error,
  info,
  instrument,
  Level,
  log,
  logfireApiConfig,
  reportError,
  span,
  startPendingSpan,
  startSpan,
  warning,
  withSettings,
  withTags,
} from './index'
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

  interface MockBaggageEntry {
    value: string
  }

  interface MockBaggage {
    getAllEntries(): [string, MockBaggageEntry][]
    getEntry(key: string): MockBaggageEntry | undefined
  }

  let contextId = 0
  let activeBaggage: MockBaggage | undefined

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

  function makeBaggage(entries: Record<string, string>): MockBaggage {
    return {
      getAllEntries: () => Object.entries(entries).map(([key, value]) => [key, { value }] as [string, MockBaggageEntry]),
      getEntry: (key: string) => {
        const value = entries[key]
        return value === undefined ? undefined : { value }
      },
    }
  }

  const activeContext = makeContext()
  const spanMock = makeSpan({ startTime: [1000, 0] })
  const noopSpan = makeSpan({ recording: false })
  const startSpanResults: MockSpan[] = []
  const getActiveBaggage = vi.fn<() => MockBaggage | undefined>(() => activeBaggage)

  const tracerMock = {
    startActiveSpan: vi.fn<(_name: string, _options: unknown, _context: unknown, fn: (s: MockSpan) => unknown) => unknown>(
      (_name, _options, _context, fn) => fn(spanMock)
    ),
    startSpan: vi.fn<(_name: string, _options?: unknown, _context?: MockContext) => MockSpan>(() => startSpanResults.shift() ?? spanMock),
  }

  return {
    activeContext,
    contextWith: vi.fn<() => unknown>(),
    getActiveBaggage,
    makeSpan,
    reset() {
      activeBaggage = undefined
      getActiveBaggage.mockClear()
      startSpanResults.length = 0
      tracerMock.startActiveSpan.mockClear()
      tracerMock.startSpan.mockClear()
      spanMock.end.mockClear()
      spanMock.isRecording.mockClear()
      spanMock.recordException.mockClear()
      spanMock.setAttribute.mockClear()
      spanMock.setStatus.mockClear()
      spanMock.spanContext.mockClear()
      noopSpan.end.mockClear()
      noopSpan.isRecording.mockClear()
      noopSpan.recordException.mockClear()
      noopSpan.setAttribute.mockClear()
      noopSpan.setStatus.mockClear()
      noopSpan.spanContext.mockClear()
    },
    setActiveBaggage(entries: Record<string, string> | undefined) {
      activeBaggage = entries === undefined ? undefined : makeBaggage(entries)
    },
    setSpan: vi.fn<(ctx: MockContext, span: MockSpan) => MockContext>((ctx, span) => ctx.setValue(Symbol.for('otel-test-span'), span)),
    noopSpan,
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
    INVALID_SPAN_CONTEXT: {
      spanId: '0000000000000000',
      traceFlags: 0,
      traceId: '00000000000000000000000000000000',
    },
    SpanStatusCode: { ERROR: 2 },
    propagation: {
      getActiveBaggage: mocks.getActiveBaggage,
    },
    trace: {
      getTracer: vi.fn<() => typeof mocks.tracerMock>(() => mocks.tracerMock),
      setSpan: mocks.setSpan,
      wrapSpanContext: vi.fn<(_context?: unknown) => typeof mocks.noopSpan>(() => mocks.noopSpan),
    },
  }
})

beforeEach(() => {
  configureLogfireApi({ baggage: { spanAttributes: [] }, errorFingerprinting: true, jsonSchema: 'rich', minLevel: null })
  mocks.setActiveBaggage(undefined)
})

function getStartSpanAttributes(callIndex = 0): Record<string, unknown> {
  return (mocks.tracerMock.startSpan.mock.calls[callIndex]?.[1] as { attributes: Record<string, unknown> }).attributes
}

function getStartActiveSpanAttributes(callIndex = 0): Record<string, unknown> {
  return (mocks.tracerMock.startActiveSpan.mock.calls[callIndex]?.[1] as { attributes: Record<string, unknown> }).attributes
}

function errorWithThrowingCauseStack(): Error {
  const normalizationFailure = new Error('cause stack getter failed')
  const cause = new Error('cause failed')
  Object.defineProperty(cause, 'stack', {
    configurable: true,
    get() {
      throw normalizationFailure
    },
  })

  const error = new Error('original failure', { cause })
  error.stack = 'Error: original failure\n    at handler (app.ts:8:1)'
  return error
}

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
          'logfire.json_schema':
            '{"properties":{"logfire.scrubbed":{"items":{"properties":{"matched_substring":{"type":"string"},"path":{"items":{"type":"string"},"type":"array"}},"type":"object"},"type":"array"}},"type":"object"}',
          'logfire.scrubbed': '[{"matched_substring":"password","path":["password"]}]',
          password: "[Scrubbed due to 'password']",
        },
      },
      mocks.activeContext
    )
  })
})

describe('baggage span attributes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('is disabled by default', () => {
    mocks.setActiveBaggage({ tenant: 'acme' })

    info('event')

    expect(getStartSpanAttributes()).not.toHaveProperty('baggage.tenant')
    expect(mocks.getActiveBaggage).not.toHaveBeenCalled()
  })

  test('copies only configured active baggage keys and skips missing keys', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant', 'missing'] } })
    mocks.setActiveBaggage({ region: 'eu', tenant: 'acme' })

    info('event')

    const attributes = getStartSpanAttributes()
    expect(attributes['baggage.tenant']).toBe('acme')
    expect(attributes).not.toHaveProperty('baggage.region')
    expect(attributes).not.toHaveProperty('baggage.missing')
  })

  test('lets explicit user attributes win over baggage projection', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'from-baggage' })

    info('event', { 'baggage.tenant': 'from-user' })

    expect(getStartSpanAttributes()['baggage.tenant']).toBe('from-user')
  })

  test('truncates projected baggage values to 1000 characters', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'x'.repeat(1005) })

    info('event')

    expect(getStartSpanAttributes()['baggage.tenant']).toBe(`${'x'.repeat(997)}...`)
  })

  test('copies baggage for startSpan', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })

    startSpan('manual span')

    expect(getStartSpanAttributes()['baggage.tenant']).toBe('acme')
  })

  test('copies baggage for object-style active span', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })

    span('active span', { callback: () => 'ok' })

    expect(getStartActiveSpanAttributes()['baggage.tenant']).toBe('acme')
  })

  test('copies baggage for positional active span', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })

    span('active span', {}, {}, () => 'ok')

    expect(getStartActiveSpanAttributes()['baggage.tenant']).toBe('acme')
  })

  test('copies baggage for real and pending placeholder spans', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })
    const startTime: [number, number] = [123, 456]
    const realSpan = mocks.makeSpan({ startTime })
    const pendingSpan = mocks.makeSpan({ startTime })
    mocks.startSpanResults.push(realSpan, pendingSpan)

    startPendingSpan('pending span')

    expect(getStartSpanAttributes(0)['baggage.tenant']).toBe('acme')
    expect(getStartSpanAttributes(1)['baggage.tenant']).toBe('acme')
  })

  test('copies baggage for reportError', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })

    reportError('caught error', new Error('boom'))

    expect(getStartSpanAttributes()['baggage.tenant']).toBe('acme')
  })

  test('copies baggage for instrumented functions', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })

    instrument(() => 'ok')()

    expect(getStartActiveSpanAttributes()['baggage.tenant']).toBe('acme')
  })

  test('scoped clients inherit baggage projection', () => {
    configureLogfireApi({ baggage: { spanAttributes: ['tenant'] } })
    mocks.setActiveBaggage({ tenant: 'acme' })

    withTags('scope').info('scoped event')

    expect(getStartSpanAttributes()['baggage.tenant']).toBe('acme')
    expect(getStartSpanAttributes()[ATTRIBUTES_TAGS_KEY]).toEqual(['scope'])
  })
})

describe('minLevel filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('filters log helpers below minLevel and keeps logs at or above minLevel', () => {
    configureLogfireApi({ minLevel: 'warning' })

    debug('debug event')
    log('default info event')
    warning('warning event')
    error('error event')

    expect(mocks.tracerMock.startSpan).toHaveBeenCalledTimes(2)
    expect(getStartSpanAttributes(0)[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
    expect(getStartSpanAttributes(1)[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Error)
    expect(spanMock.end).toHaveBeenCalledTimes(2)
    expect(mocks.noopSpan.end).toHaveBeenCalledTimes(2)
  })

  test('filters explicit manual spans while preserving unlevelled spans', () => {
    configureLogfireApi({ minLevel: 'fatal' })

    expect(startSpan('manual span')).toBe(spanMock)
    expect(mocks.tracerMock.startSpan).toHaveBeenCalledOnce()

    mocks.reset()

    expect(startSpan('debug span', {}, { level: Level.Debug })).toBe(mocks.noopSpan)
    expect(startPendingSpan('debug pending span', {}, { level: Level.Debug })).toBe(mocks.noopSpan)
    expect(mocks.tracerMock.startSpan).not.toHaveBeenCalled()
  })

  test('filters explicit active spans with a no-op span and still runs sync callbacks', () => {
    configureLogfireApi({ minLevel: 'warning' })
    const callback = vi.fn<(activeSpan: Span) => string>(() => 'ok')

    const result = span('debug active span', { level: Level.Debug, callback })

    expect(result).toBe('ok')
    expect(callback).toHaveBeenCalledWith(mocks.noopSpan)
    expect(mocks.tracerMock.startActiveSpan).not.toHaveBeenCalled()
    expect(spanMock.end).not.toHaveBeenCalled()
    expect(spanMock.recordException).not.toHaveBeenCalled()
  })

  test('filters positional active spans with explicit levels', () => {
    configureLogfireApi({ minLevel: 'warning' })
    const callback = vi.fn<(activeSpan: Span) => string>(() => 'ok')

    const result = span('debug active span', { id: 1 }, { level: Level.Debug }, callback)

    expect(result).toBe('ok')
    expect(callback).toHaveBeenCalledWith(mocks.noopSpan)
    expect(mocks.tracerMock.startActiveSpan).not.toHaveBeenCalled()
    expect(mocks.getActiveBaggage).not.toHaveBeenCalled()
  })

  test('does not record filtered active span callback failures', async () => {
    configureLogfireApi({ minLevel: 'warning' })
    const syncError = new Error('sync failure')
    const asyncError = new Error('async failure')

    expect(() =>
      span('debug active span', {
        level: Level.Debug,
        callback: () => {
          throw syncError
        },
      })
    ).toThrow(syncError)

    await expect(
      span('debug async span', {
        level: Level.Debug,
        callback: async () => Promise.reject(asyncError),
      })
    ).rejects.toThrow(asyncError)

    expect(mocks.tracerMock.startActiveSpan).not.toHaveBeenCalled()
    expect(spanMock.recordException).not.toHaveBeenCalled()
    expect(mocks.noopSpan.recordException).not.toHaveBeenCalled()
    expect(spanMock.end).not.toHaveBeenCalled()
    expect(mocks.noopSpan.end).not.toHaveBeenCalled()
  })

  test('filters reportError only when error level is below minLevel', () => {
    configureLogfireApi({ minLevel: 'fatal' })

    reportError('caught error', new Error('boom'))

    expect(mocks.tracerMock.startSpan).not.toHaveBeenCalled()
    expect(spanMock.recordException).not.toHaveBeenCalled()
    expect(mocks.noopSpan.recordException).toHaveBeenCalledWith(expect.any(Error))

    mocks.reset()
    configureLogfireApi({ minLevel: 'error' })

    reportError('caught error', new Error('boom'))

    expect(mocks.tracerMock.startSpan).toHaveBeenCalledOnce()
    expect(getStartSpanAttributes()[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Error)
  })

  test('filters instrumented calls before creating span attributes', () => {
    configureLogfireApi({ minLevel: 'warning' })
    const fn = vi.fn<(payload: { id: string }) => { id: string }>((payload) => ({ id: payload.id }))
    const wrapped = instrument(fn, {
      extractArgs: ['payload'],
      level: Level.Debug,
      recordReturn: true,
    })

    expect(wrapped({ id: '123' })).toEqual({ id: '123' })

    expect(fn).toHaveBeenCalledWith({ id: '123' })
    expect(mocks.tracerMock.startActiveSpan).not.toHaveBeenCalled()
    expect(spanMock.setAttribute).not.toHaveBeenCalled()
  })

  test('filtered async instrumented calls still resolve their original value', async () => {
    configureLogfireApi({ minLevel: 'warning' })
    const wrapped = instrument(
      async () => {
        await sleep(0)
        return 'ok'
      },
      { level: Level.Debug, recordReturn: true }
    )

    await expect(wrapped()).resolves.toBe('ok')

    expect(mocks.tracerMock.startActiveSpan).not.toHaveBeenCalled()
    expect(spanMock.setAttribute).not.toHaveBeenCalled()
  })

  test('does not filter instrumented calls without an explicit level', () => {
    configureLogfireApi({ minLevel: 'fatal' })
    const wrapped = instrument(() => 'ok')

    expect(wrapped()).toBe('ok')

    expect(mocks.tracerMock.startActiveSpan).toHaveBeenCalledOnce()
    expect(getStartActiveSpanAttributes()[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Info)
  })

  test('applies scoped levels and helper overrides before filtering', () => {
    configureLogfireApi({ minLevel: 'warning' })
    const scoped = withSettings({ level: Level.Debug })

    scoped.log('scoped debug event')
    scoped.warning('scoped warning event')

    expect(mocks.tracerMock.startSpan).toHaveBeenCalledOnce()
    expect(getStartSpanAttributes()[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
  })

  test('parses minLevel names case-insensitively and resets with null', () => {
    configureLogfireApi({ minLevel: ' WARNING ' as 'warning' })

    debug('debug event')
    warning('warning event')

    expect(mocks.tracerMock.startSpan).toHaveBeenCalledOnce()
    expect(logfireApiConfig.minLevel).toBe(Level.Warning)

    mocks.reset()
    configureLogfireApi({ minLevel: null })
    error('error event')

    expect(logfireApiConfig.minLevel).toBeUndefined()
    expect(mocks.tracerMock.startSpan).toHaveBeenCalledOnce()
  })

  test('rejects invalid code-configured minLevel values', () => {
    expect(() => {
      configureLogfireApi({ minLevel: 12 as never })
    }).toThrow('Invalid minLevel')

    expect(() => {
      configureLogfireApi({ minLevel: 'warn' as never })
    }).toThrow('Invalid minLevel')
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

  test('sync callback throws Error with cause - records cause chain in exception stacktrace', () => {
    const cause = Object.assign(new TypeError('database unavailable'), {
      details: { retryable: true },
      statusCode: 503,
    })
    cause.stack = 'TypeError: database unavailable\n    at query (db.ts:12:3)'
    const error = new Error('request failed', { cause })
    error.stack = 'Error: request failed\n    at handler (app.ts:8:1)'
    const expectedStack = `${error.stack}\nCaused by: ${cause.stack}`

    expect(() =>
      span('test', {
        attributes: { payload: { id: '123' } },
        callback: () => {
          throw error
        },
      })
    ).toThrow(error)

    expect(spanMock.recordException).toHaveBeenCalledWith({
      message: 'request failed',
      name: 'Error',
      stack: expectedStack,
    })
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: request failed' })
    const causeAttribute = spanMock.setAttribute.mock.calls.find(([key]) => key === 'exception.cause')?.[1]
    expect(JSON.parse(causeAttribute as string)).toEqual({
      details: { retryable: true },
      message: 'database unavailable',
      stacktrace: cause.stack,
      statusCode: 503,
      type: 'TypeError',
    })
    const schemaAttribute = spanMock.setAttribute.mock.calls.find(([key]) => key === JSON_SCHEMA_KEY)?.[1]
    expect(JSON.parse(schemaAttribute as string)).toMatchObject({
      properties: {
        'exception.cause': {
          properties: {
            details: {
              properties: {
                retryable: { type: 'boolean' },
              },
              type: 'object',
            },
            message: { type: 'string' },
            stacktrace: { type: 'string' },
            statusCode: { type: 'number' },
            type: { type: 'string' },
          },
          type: 'object',
        },
        payload: {
          properties: {
            id: { type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    })
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('sync callback throws Error with nested causes - records full cause chain', () => {
    const databaseCause = Object.assign(new Error('database unavailable'), {
      details: { host: 'primary-db', retryable: true },
      statusCode: 503,
    })
    databaseCause.stack = 'Error: database unavailable\n    at query (db.ts:12:3)'
    const serviceCause = Object.assign(new TypeError('checkout storage failed', { cause: databaseCause }), {
      operation: 'checkout.create_order',
      requestId: 'req_nested_span',
    })
    serviceCause.stack = 'TypeError: checkout storage failed\n    at saveOrder (checkout.ts:8:1)'
    const error = new Error('request failed', { cause: serviceCause })
    error.stack = 'Error: request failed\n    at handler (app.ts:4:1)'
    const expectedStack = `${error.stack}\nCaused by: ${serviceCause.stack}\nCaused by: ${databaseCause.stack}`

    expect(() =>
      span('test', {
        callback: () => {
          throw error
        },
      })
    ).toThrow(error)

    expect(spanMock.recordException).toHaveBeenCalledWith({
      message: 'request failed',
      name: 'Error',
      stack: expectedStack,
    })
    const causeAttribute = spanMock.setAttribute.mock.calls.find(([key]) => key === 'exception.cause')?.[1]
    expect(JSON.parse(causeAttribute as string)).toEqual({
      cause: {
        details: { host: 'primary-db', retryable: true },
        message: 'database unavailable',
        stacktrace: databaseCause.stack,
        statusCode: 503,
        type: 'Error',
      },
      message: 'checkout storage failed',
      operation: 'checkout.create_order',
      requestId: 'req_nested_span',
      stacktrace: serviceCause.stack,
      type: 'TypeError',
    })
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('sync callback throws Error with circular causes - records circular marker', () => {
    const databaseCause = Object.assign(new Error('database unavailable'), {
      details: { host: 'primary-db' },
    })
    databaseCause.stack = 'Error: database unavailable\n    at query (db.ts:12:3)'
    const serviceCause = Object.assign(new Error('checkout storage failed', { cause: databaseCause }), {
      operation: 'checkout.create_order',
    })
    serviceCause.stack = 'Error: checkout storage failed\n    at saveOrder (checkout.ts:8:1)'
    const error = new Error('request failed', { cause: serviceCause })
    error.stack = 'Error: request failed\n    at handler (app.ts:4:1)'
    ;(databaseCause as Error & { cause: Error }).cause = error
    const expectedStack = `${error.stack}\nCaused by: ${serviceCause.stack}\nCaused by: ${databaseCause.stack}\nCaused by: [Circular cause: Error: request failed]`

    expect(() =>
      span('test', {
        callback: () => {
          throw error
        },
      })
    ).toThrow(error)

    expect(spanMock.recordException).toHaveBeenCalledWith({
      message: 'request failed',
      name: 'Error',
      stack: expectedStack,
    })
    const causeAttribute = spanMock.setAttribute.mock.calls.find(([key]) => key === 'exception.cause')?.[1]
    expect(JSON.parse(causeAttribute as string)).toEqual({
      cause: {
        cause: {
          circular: true,
          message: 'request failed',
          type: 'Error',
        },
        details: { host: 'primary-db' },
        message: 'database unavailable',
        stacktrace: databaseCause.stack,
        type: 'Error',
      },
      message: 'checkout storage failed',
      operation: 'checkout.create_order',
      stacktrace: serviceCause.stack,
      type: 'Error',
    })
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('sync callback preserves original Error when cause normalization throws', () => {
    const error = errorWithThrowingCauseStack()
    let caught: unknown

    try {
      span('test', {
        callback: () => {
          throw error
        },
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(error)
    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: original failure' })
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

  test('records Error cause chain in reportError stacktrace', () => {
    const cause = Object.assign(new TypeError('database unavailable'), {
      details: { retryable: true },
      statusCode: 503,
    })
    cause.stack = 'TypeError: database unavailable\n    at query (db.ts:12:3)'
    const error = new Error('request failed', { cause })
    error.stack = 'Error: request failed\n    at handler (app.ts:8:1)'
    const expectedStack = `${error.stack}\nCaused by: ${cause.stack}`

    reportError('Caught error', error)

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTR_EXCEPTION_MESSAGE]).toBe('request failed')
    expect(attributes[ATTR_EXCEPTION_STACKTRACE]).toBe(expectedStack)
    expect(JSON.parse(attributes['exception.cause'] as string)).toEqual({
      details: { retryable: true },
      message: 'database unavailable',
      stacktrace: cause.stack,
      statusCode: 503,
      type: 'TypeError',
    })
    expect(JSON.parse(attributes[JSON_SCHEMA_KEY] as string)).toMatchObject({
      properties: {
        'exception.cause': {
          properties: {
            details: {
              properties: {
                retryable: { type: 'boolean' },
              },
              type: 'object',
            },
            message: { type: 'string' },
            stacktrace: { type: 'string' },
            statusCode: { type: 'number' },
            type: { type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    })
    expect(spanMock.recordException).toHaveBeenCalledWith({
      message: 'request failed',
      name: 'Error',
      stack: expectedStack,
    })
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: request failed' })
  })

  test('records nested Error cause chain in reportError stacktrace', () => {
    const databaseCause = Object.assign(new Error('database unavailable'), {
      details: { host: 'primary-db', retryable: true },
      statusCode: 503,
    })
    databaseCause.stack = 'Error: database unavailable\n    at query (db.ts:12:3)'
    const serviceCause = Object.assign(new TypeError('checkout storage failed', { cause: databaseCause }), {
      operation: 'checkout.create_order',
      requestId: 'req_nested_report_error',
    })
    serviceCause.stack = 'TypeError: checkout storage failed\n    at saveOrder (checkout.ts:8:1)'
    const error = new Error('request failed', { cause: serviceCause })
    error.stack = 'Error: request failed\n    at handler (app.ts:4:1)'
    const expectedStack = `${error.stack}\nCaused by: ${serviceCause.stack}\nCaused by: ${databaseCause.stack}`

    reportError('Caught error', error)

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTR_EXCEPTION_STACKTRACE]).toBe(expectedStack)
    expect(JSON.parse(attributes['exception.cause'] as string)).toEqual({
      cause: {
        details: { host: 'primary-db', retryable: true },
        message: 'database unavailable',
        stacktrace: databaseCause.stack,
        statusCode: 503,
        type: 'Error',
      },
      message: 'checkout storage failed',
      operation: 'checkout.create_order',
      requestId: 'req_nested_report_error',
      stacktrace: serviceCause.stack,
      type: 'TypeError',
    })
    expect(spanMock.recordException).toHaveBeenCalledWith({
      message: 'request failed',
      name: 'Error',
      stack: expectedStack,
    })
  })

  test('records circular Error cause chain in reportError stacktrace', () => {
    const databaseCause = Object.assign(new Error('database unavailable'), {
      details: { host: 'primary-db' },
    })
    databaseCause.stack = 'Error: database unavailable\n    at query (db.ts:12:3)'
    const serviceCause = Object.assign(new Error('checkout storage failed', { cause: databaseCause }), {
      operation: 'checkout.create_order',
    })
    serviceCause.stack = 'Error: checkout storage failed\n    at saveOrder (checkout.ts:8:1)'
    const error = new Error('request failed', { cause: serviceCause })
    error.stack = 'Error: request failed\n    at handler (app.ts:4:1)'
    ;(databaseCause as Error & { cause: Error }).cause = error
    const expectedStack = `${error.stack}\nCaused by: ${serviceCause.stack}\nCaused by: ${databaseCause.stack}\nCaused by: [Circular cause: Error: request failed]`

    reportError('Caught error', error)

    const attributes = (mocks.tracerMock.startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTR_EXCEPTION_STACKTRACE]).toBe(expectedStack)
    expect(JSON.parse(attributes['exception.cause'] as string)).toEqual({
      cause: {
        cause: {
          circular: true,
          message: 'request failed',
          type: 'Error',
        },
        details: { host: 'primary-db' },
        message: 'database unavailable',
        stacktrace: databaseCause.stack,
        type: 'Error',
      },
      message: 'checkout storage failed',
      operation: 'checkout.create_order',
      stacktrace: serviceCause.stack,
      type: 'Error',
    })
    expect(spanMock.recordException).toHaveBeenCalledWith({
      message: 'request failed',
      name: 'Error',
      stack: expectedStack,
    })
  })

  test('does not throw when cause normalization fails', () => {
    const error = errorWithThrowingCauseStack()

    expect(() => {
      reportError('Caught error', error)
    }).not.toThrow()

    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: original failure' })
    expect(spanMock.end).toHaveBeenCalledOnce()
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

describe('instrument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  test('sync wrapper returns the original value and emits a span', () => {
    function fetchUser(id: string) {
      return { id }
    }

    const wrapped = instrument(fetchUser, { extractArgs: ['id'], message: 'fetch user {id}' })
    const result = wrapped('user-123')

    expect(result).toEqual({ id: 'user-123' })
    expect(mocks.tracerMock.startActiveSpan.mock.calls[0]?.[0]).toBe('fetch user {id}')
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_MESSAGE_TEMPLATE_KEY]).toBe('fetch user {id}')
    expect(attributes[ATTRIBUTES_MESSAGE_KEY]).toBe('fetch user user-123')
    expect(attributes['id']).toBe('user-123')
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('async wrapper resolves the original value and ends the span after settlement', async () => {
    async function fetchUser(id: string) {
      await sleep(0)
      return { id }
    }

    const wrapped = instrument(fetchUser, { extractArgs: ['id'], message: 'fetch user {id}' })
    await expect(wrapped('user-123')).resolves.toEqual({ id: 'user-123' })

    expect(spanMock.end).toHaveBeenCalledOnce()
    expect(spanMock.recordException).not.toHaveBeenCalled()
  })

  test('sync thrown errors are recorded and rethrown', () => {
    const error = new Error('boom')
    const wrapped = instrument(() => {
      throw error
    })

    expect(() => wrapped()).toThrow(error)
    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: boom' })
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('async rejected errors are recorded and rejected', async () => {
    const error = new Error('async-boom')
    const wrapped = instrument(async () => Promise.reject(error))

    await expect(wrapped()).rejects.toThrow(error)
    await sleep(0)

    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: async-boom' })
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('wrapper preserves this', () => {
    const service = {
      multiplier: 3,
      calculate: instrument(function (this: { multiplier: number }, value: number) {
        return this.multiplier * value
      }),
    }

    expect(service.calculate(4)).toBe(12)
  })

  test('default message uses the function name', () => {
    function namedFunction() {
      return 'ok'
    }

    instrument(namedFunction)()

    expect(mocks.tracerMock.startActiveSpan.mock.calls[0]?.[0]).toBe('Calling namedFunction')
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_MESSAGE_TEMPLATE_KEY]).toBe('Calling namedFunction')
    expect(attributes[ATTRIBUTES_MESSAGE_KEY]).toBe('Calling namedFunction')
  })

  test('custom message and spanName are used independently', () => {
    const wrapped = instrument(() => 'ok', {
      message: 'friendly {id}',
      spanName: 'stable-operation',
      attributes: { id: 1 },
    })

    wrapped()

    expect(mocks.tracerMock.startActiveSpan.mock.calls[0]?.[0]).toBe('stable-operation')
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_MESSAGE_TEMPLATE_KEY]).toBe('friendly {id}')
    expect(attributes[ATTRIBUTES_MESSAGE_KEY]).toBe('friendly 1')
  })

  test('extractArgs defaults to no argument attributes', () => {
    function fetchUser(id: string) {
      return id
    }

    instrument(fetchUser, { message: 'fetch user' })('user-123')

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes).not.toHaveProperty('id')
    expect(attributes).not.toHaveProperty('arg0')
  })

  test('extractArgs with names records positional arguments', () => {
    function fetchUser(id: string, includeDetails: boolean) {
      return { id, includeDetails }
    }

    instrument(fetchUser, {
      extractArgs: ['id', 'include_details'],
      message: 'fetch user {id}',
    })('user-123', true)

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes['id']).toBe('user-123')
    expect(attributes['include_details']).toBe(true)
  })

  test('extractArgs true records best-effort parameter names', () => {
    function fetchUser(id: string, includeDetails: boolean) {
      return { id, includeDetails }
    }

    instrument(fetchUser, {
      extractArgs: true,
      message: 'fetch user {id}',
    })('user-123', true)

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes['id']).toBe('user-123')
    expect(attributes['includeDetails']).toBe(true)
  })

  test('extractArgs true falls back to arg names for bare-arrow functions', () => {
    const identity = ((id: string) => id) as ((id: string) => string) & { toString: () => string }
    identity.toString = () => 'id => id'

    instrument(identity, {
      extractArgs: true,
      message: 'fetch user {arg0}',
    })('user-123')

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes['arg0']).toBe('user-123')
    expect(attributes[ATTRIBUTES_MESSAGE_KEY]).toBe('fetch user user-123')
  })

  test('extracted args override static attributes', () => {
    function fetchUser(id: string) {
      return id
    }

    instrument(fetchUser, {
      attributes: { id: 'static' },
      extractArgs: ['id'],
      message: 'fetch user {id}',
    })('actual')

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes['id']).toBe('actual')
    expect(attributes[ATTRIBUTES_MESSAGE_KEY]).toBe('fetch user actual')
  })

  test('recordReturn true records sync return values', () => {
    const wrapped = instrument(
      () => ({
        ok: true,
      }),
      { recordReturn: true }
    )

    expect(wrapped()).toEqual({ ok: true })
    expect(spanMock.setAttribute).toHaveBeenCalledWith('return', '{"ok":true}')
    expect(spanMock.setAttribute).toHaveBeenCalledWith(
      'logfire.json_schema',
      '{"properties":{"return":{"properties":{"ok":{"type":"boolean"}},"type":"object"}},"type":"object"}'
    )
  })

  test('recordReturn true preserves complex input schema when recording complex return values', () => {
    function processPayload(_payload: { value: string }) {
      return { status: 'ok' }
    }

    const wrapped = instrument(processPayload, {
      extractArgs: ['payload'],
      recordReturn: true,
    })

    expect(wrapped({ value: 'input' })).toEqual({ status: 'ok' })

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[JSON_SCHEMA_KEY]).toBe(
      '{"properties":{"payload":{"properties":{"value":{"type":"string"}},"type":"object"}},"type":"object"}'
    )
    expect(spanMock.setAttribute).toHaveBeenCalledWith('return', '{"status":"ok"}')
    expect(spanMock.setAttribute).toHaveBeenCalledWith(
      JSON_SCHEMA_KEY,
      '{"properties":{"payload":{"properties":{"value":{"type":"string"}},"type":"object"},"return":{"properties":{"status":{"type":"string"}},"type":"object"}},"type":"object"}'
    )
  })

  test('recordReturn true preserves null input metadata when recording null return values', () => {
    function processPayload(payload: null) {
      return payload
    }

    const wrapped = instrument(processPayload, {
      extractArgs: ['payload'],
      recordReturn: true,
    })

    expect(wrapped(null)).toBeNull()

    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[JSON_NULL_FIELDS_KEY]).toEqual(['payload'])
    expect(spanMock.setAttribute).toHaveBeenCalledWith(JSON_NULL_FIELDS_KEY, ['payload', 'return'])
  })

  test('recordReturn true records async resolved values', async () => {
    const wrapped = instrument(
      async () => {
        await sleep(0)
        return ['ok']
      },
      { recordReturn: true }
    )

    await expect(wrapped()).resolves.toEqual(['ok'])

    expect(spanMock.setAttribute).toHaveBeenCalledWith('return', '["ok"]')
    expect(spanMock.setAttribute).toHaveBeenCalledWith(
      'logfire.json_schema',
      '{"properties":{"return":{"items":{"type":"string"},"type":"array"}},"type":"object"}'
    )
  })

  test('recordReturn true records resolved non-Promise thenable values', async () => {
    const thenable: PromiseLike<{ ok: boolean }> = {
      async then(onFulfilled, onRejected) {
        return Promise.resolve({ ok: true }).then(onFulfilled, onRejected)
      },
    }
    const wrapped = instrument(() => thenable, { recordReturn: true })

    await expect(wrapped()).resolves.toEqual({ ok: true })

    expect(spanMock.setAttribute).toHaveBeenCalledWith('return', '{"ok":true}')
    expect(spanMock.setAttribute).toHaveBeenCalledWith(
      JSON_SCHEMA_KEY,
      '{"properties":{"return":{"properties":{"ok":{"type":"boolean"}},"type":"object"}},"type":"object"}'
    )
  })

  test('recordReturn true records circular return values with a cycle placeholder', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const wrapped = instrument(() => circular, { recordReturn: true })

    expect(wrapped()).toBe(circular)
    expect(spanMock.setAttribute).toHaveBeenCalledWith('return', '{"self":"[Scrubbed due to cycle]"}')
  })

  test('recordReturn true does not record thrown or rejected values', async () => {
    const syncWrapped = instrument(
      () => {
        throw new Error('sync')
      },
      { recordReturn: true }
    )
    const asyncWrapped = instrument(async () => Promise.reject(new Error('async')), { recordReturn: true })

    expect(() => syncWrapped()).toThrow('sync')
    await expect(asyncWrapped()).rejects.toThrow('async')
    await sleep(0)

    expect(spanMock.setAttribute).not.toHaveBeenCalledWith('return', expect.anything())
  })

  test('tags, parentSpan, and level are passed to the span', () => {
    const parentSpan = mocks.makeSpan({ startTime: [100, 0] })

    instrument(() => 'ok', {
      level: Level.Warning,
      parentSpan: parentSpan as unknown as Span,
      tags: ['instrumented'],
    })()

    expect(mocks.setSpan).toHaveBeenCalledWith(mocks.activeContext, parentSpan)
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['instrumented'])
  })

  test('scoped client instrument merges scoped settings', () => {
    const wrapped = withSettings({ level: Level.Warning, tags: ['scope', 'shared'] }).instrument(() => 'ok', {
      tags: ['shared', 'call'],
    })

    expect(wrapped()).toBe('ok')
    const attributes = (mocks.tracerMock.startActiveSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes
    expect(attributes[ATTRIBUTES_LEVEL_KEY]).toBe(Level.Warning)
    expect(attributes[ATTRIBUTES_TAGS_KEY]).toEqual(['scope', 'shared', 'call'])
  })

  test('default export exposes instrument', () => {
    const defaultInstrument = Object.getOwnPropertyDescriptor(defaultExport, 'instrument')?.value as typeof instrument

    expect(defaultInstrument).toBe(instrument)
    expect(defaultInstrument(() => 'ok')()).toBe('ok')
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
