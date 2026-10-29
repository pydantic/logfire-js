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
  vi.useRealTimers()
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

  it('ends the first span one task later, at the time the last listener returned', () => {
    vi.useFakeTimers()
    const end = vi.fn<(endTime?: number) => void>()
    const firstSpan = { end, spanContext: () => createdSpan.spanContext() } as unknown as Span
    const instrumentation = fakeInstrumentation({ _createSpan: vi.fn<CreateSpan>(() => firstSpan) })
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(25).mockReturnValueOnce(40)
    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    const span = instrumentation._createSpan?.('element', 'click')
    span?.end()
    // The instrumentation passes each listener the span it returned for the previous listener.
    const secondListenerSpan = instrumentation._createSpan?.('element', 'click', span)
    secondListenerSpan?.end()
    instrumentation._createSpan?.('element', 'click', secondListenerSpan)?.end()
    expect(end).not.toHaveBeenCalled()
    vi.runAllTimers()

    expect(end.mock.calls).toEqual([[40]])
  })

  it('delegates to the instrumentation after it is disabled', () => {
    const instrumentation = fakeInstrumentation({ _createSpan: vi.fn<CreateSpan>(() => undefined), _isEnabled: false })
    const createSpan = instrumentation._createSpan

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    expect(instrumentation._createSpan?.('element', 'click', parentSpan)).toBeUndefined()
    expect(createSpan).toHaveBeenCalledWith('element', 'click', parentSpan)
  })

  it('skips the event and warns once when the instrumentation cannot create a span', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => undefined)
    const error = new Error('Permission denied to access property "localName"')
    const instrumentation = fakeInstrumentation({
      _createSpan: vi.fn<CreateSpan>(() => {
        throw error
      }),
    })

    collapseUserInteractionSpans([instrumentation as unknown as Instrumentation])

    expect(instrumentation._createSpan?.('element', 'click')).toBeUndefined()
    expect(instrumentation._createSpan?.('element', 'click')).toBeUndefined()
    expect(warn.mock.calls).toEqual([
      ['logfire-browser: the user interaction instrumentation could not create a span; skipping the event', error],
    ])
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
