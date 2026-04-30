import { SpanStatusCode, trace } from '@opentelemetry/api'
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY,
  ATTRIBUTES_LEVEL_KEY,
  ATTRIBUTES_MESSAGE_KEY,
  ATTRIBUTES_MESSAGE_TEMPLATE_KEY,
  ATTRIBUTES_SPAN_TYPE_KEY,
  ATTRIBUTES_TAGS_KEY,
} from './constants'
import { info, span } from './index'

const { spanMock } = vi.hoisted(() => {
  const spanMock = {
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  }
  return { spanMock }
})

vi.mock('@opentelemetry/api', () => {
  const tracerMock = {
    startActiveSpan: vi.fn((_name: string, _options: unknown, _context: unknown, fn: (s: typeof spanMock) => unknown) => fn(spanMock)),
    startSpan: vi.fn(() => spanMock),
  }

  return {
    context: {
      active: vi.fn(),
    },
    SpanStatusCode: { ERROR: 2 },
    trace: {
      getTracer: vi.fn(() => tracerMock),
      setSpan: vi.fn(),
    },
  }
})

describe('info', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      undefined
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
      undefined
    )
  })
})

describe('span', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    const result = span('test', { callback: () => Promise.resolve('async-ok') })
    await expect(result).resolves.toBe('async-ok')

    expect(spanMock.end).toHaveBeenCalledOnce()
    expect(spanMock.recordException).not.toHaveBeenCalled()
    expect(spanMock.setStatus).not.toHaveBeenCalled()
  })

  test('async callback rejects with Error - records exception', async () => {
    const error = new Error('async-boom')
    const result = span('test', { callback: () => Promise.reject(error) })

    await expect(result).rejects.toThrow(error)

    // Allow microtask for the .then() handler to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spanMock.recordException).toHaveBeenCalledWith(error)
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: async-boom' })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_LEVEL_KEY, 17)
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, expect.any(String))
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('async callback rejects with string - records exception without fingerprint', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors, @typescript-eslint/prefer-promise-reject-errors
    const result = span('test', { callback: () => Promise.reject('async-oops') })

    await expect(result).rejects.toBe('async-oops')

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spanMock.recordException).toHaveBeenCalledWith('async-oops')
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: async-oops' })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(ATTRIBUTES_LEVEL_KEY, 17)
    expect(spanMock.setAttribute).not.toHaveBeenCalledWith(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, expect.anything())
    expect(spanMock.end).toHaveBeenCalledOnce()
  })

  test('thenable callback result is returned untouched', () => {
    const then = vi.fn()
    const lazyThenable = { then }

    const result = span('test', { callback: () => lazyThenable })

    expect(result).toBe(lazyThenable)
    expect(then).not.toHaveBeenCalled()
    expect(spanMock.end).toHaveBeenCalledOnce()
  })
})
