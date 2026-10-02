/* eslint-disable no-underscore-dangle -- The tests drive private members of the upstream user interaction instrumentation. */
import type { Span } from '@opentelemetry/api'
import { diag, trace } from '@opentelemetry/api'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { collapseUserInteractionSpans } from './userInteraction'

const parentSpan = trace.wrapSpanContext({ spanId: '0123456789abcdef', traceFlags: 1, traceId: '0123456789abcdef0123456789abcdef' })
const createdSpan = trace.wrapSpanContext({ spanId: 'fedcba9876543210', traceFlags: 1, traceId: 'fedcba9876543210fedcba9876543210' })

type CreateSpan = (element: unknown, eventName: string, parentSpan?: Span) => Span | undefined

interface FakeUserInteraction {
  _createSpan?: CreateSpan | undefined
  _isEnabled?: boolean
  instrumentationName: string
}

function fakeInstrumentation(overrides: Partial<FakeUserInteraction> = {}): FakeUserInteraction {
  return {
    _createSpan: vi.fn<CreateSpan>(() => createdSpan),
    _isEnabled: true,
    instrumentationName: '@opentelemetry/instrumentation-user-interaction',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('collapseUserInteractionSpans', () => {
  it('reuses the span context of the first listener for later listeners of the same event', () => {
    const instrumentation = fakeInstrumentation()
    const createSpan = instrumentation._createSpan

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    const span = instrumentation._createSpan?.('element', 'click', parentSpan)
    expect(span?.spanContext()).toEqual(parentSpan.spanContext())
    expect(span?.isRecording()).toBe(false)
    expect(createSpan).not.toHaveBeenCalled()
  })

  it('creates the first span through the instrumentation', () => {
    const instrumentation = fakeInstrumentation()
    const createSpan = instrumentation._createSpan

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    expect(instrumentation._createSpan?.('element', 'click')).toBe(createdSpan)
    expect(createSpan).toHaveBeenCalledWith('element', 'click', undefined)
  })

  it('delegates to the instrumentation after it is disabled', () => {
    const instrumentation = fakeInstrumentation({ _createSpan: vi.fn<CreateSpan>(() => undefined), _isEnabled: false })
    const createSpan = instrumentation._createSpan

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    expect(instrumentation._createSpan?.('element', 'click', parentSpan)).toBeUndefined()
    expect(createSpan).toHaveBeenCalledWith('element', 'click', parentSpan)
  })

  it('leaves other instrumentations unchanged', () => {
    const createSpan = vi.fn<CreateSpan>(() => createdSpan)
    const instrumentation = fakeInstrumentation({ _createSpan: createSpan, instrumentationName: '@opentelemetry/instrumentation-fetch' })

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    expect(instrumentation._createSpan).toBe(createSpan)
  })

  it('warns and keeps the instrumentation unchanged when _createSpan is missing', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => undefined)
    const instrumentation = fakeInstrumentation({ _createSpan: undefined })

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    expect(instrumentation._createSpan).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      'logfire-browser: the user interaction instrumentation has no _createSpan; it can export one span per event listener'
    )
  })
})
