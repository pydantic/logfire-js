/* eslint-disable @typescript-eslint/unbound-method */
import type { Context } from '@opentelemetry/api'
import { ROOT_CONTEXT } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { describe, expect, it, vi } from 'vite-plus/test'

import { LogfireSpanProcessor } from './LogfireSpanProcessor'

function makeWrapped(): SpanProcessor & { started: Span[] } {
  const started: Span[] = []
  return {
    forceFlush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onEnd: vi.fn<(span: ReadableSpan) => void>(),
    onStart: vi.fn<(span: Span, parentContext: Context) => void>((span) => {
      started.push(span)
    }),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    started,
  }
}

function makeSpan(attributes: Record<string, unknown>, name = 'GET'): Span {
  return { attributes, name } as unknown as Span
}

describe('LogfireSpanProcessor', () => {
  it('appends the path to fetch span names', () => {
    const wrapped = makeWrapped()
    const processor = new LogfireSpanProcessor(wrapped, false)
    const span = makeSpan({ 'http.url': 'https://example.com/api/thing?q=1' })

    processor.onStart(span, ROOT_CONTEXT)

    expect(span.name).toBe('GET /api/thing')
    expect(wrapped.onStart).toHaveBeenCalledTimes(1)
  })

  it('leaves the name alone when http.url is not an absolute url', () => {
    const wrapped = makeWrapped()
    const processor = new LogfireSpanProcessor(wrapped, false)
    const span = makeSpan({ 'http.url': '/api/thing' })

    expect(() => {
      processor.onStart(span, ROOT_CONTEXT)
    }).not.toThrow()
    expect(span.name).toBe('GET')
    expect(wrapped.onStart).toHaveBeenCalledTimes(1)
  })

  it('leaves the name alone when http.url is not a string', () => {
    const wrapped = makeWrapped()
    const processor = new LogfireSpanProcessor(wrapped, false)
    const span = makeSpan({ 'http.url': 42 })

    expect(() => {
      processor.onStart(span, ROOT_CONTEXT)
    }).not.toThrow()
    expect(span.name).toBe('GET')
    expect(wrapped.onStart).toHaveBeenCalledTimes(1)
  })

  it('renames interaction spans from the event type and target', () => {
    const wrapped = makeWrapped()
    const processor = new LogfireSpanProcessor(wrapped, false)
    const span = makeSpan({ event_type: 'click', target_xpath: '//button[1]' })

    processor.onStart(span, ROOT_CONTEXT)

    expect(span.name).toBe('click //button[1]')
  })
})
