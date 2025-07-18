import { trace } from '@opentelemetry/api'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ATTRIBUTES_LEVEL_KEY, ATTRIBUTES_MESSAGE_TEMPLATE_KEY, ATTRIBUTES_SPAN_TYPE_KEY, ATTRIBUTES_TAGS_KEY } from './constants'
import { info } from './index'

vi.mock('@opentelemetry/api', () => {
  const spanMock = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  }

  const tracerMock = {
    startSpan: vi.fn(() => spanMock),
  }

  return {
    context: {
      active: vi.fn(),
    },
    trace: {
      getTracer: vi.fn(() => tracerMock),
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
      'aha 1',
      {
        attributes: {
          [ATTRIBUTES_LEVEL_KEY]: 9,
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
      'aha 1',
      {
        attributes: {
          [ATTRIBUTES_LEVEL_KEY]: 9,
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
