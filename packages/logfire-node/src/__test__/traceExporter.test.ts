import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { describe, expect, it, vi } from 'vite-plus/test'

import { LogfireSpanProcessor } from '../traceExporter'

function processor(overrides: Partial<SpanProcessor> = {}): SpanProcessor {
  return {
    forceFlush: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
    onEnd: () => undefined,
    onStart: () => undefined,
    shutdown: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
    ...overrides,
  }
}

describe('LogfireSpanProcessor lifecycle', () => {
  it('shuts the batch processor down even when the console one fails', async () => {
    const consoleError = new Error('console shutdown failed')
    const wrappedShutdown = vi.fn<() => Promise<void>>(async () => Promise.resolve())
    const wrapped = processor({ shutdown: wrappedShutdown })
    const console = processor({ shutdown: vi.fn<() => Promise<void>>(async () => Promise.reject(consoleError)) })

    // Awaiting in sequence skipped this call - the one that exports the queued spans.
    await expect(new LogfireSpanProcessor(wrapped, console).shutdown()).rejects.toBe(consoleError)
    expect(wrappedShutdown).toHaveBeenCalledOnce()
  })

  it('flushes the batch processor even when the console one fails, rethrowing the lone failure', async () => {
    const consoleError = new Error('console flush failed')
    const wrappedForceFlush = vi.fn<() => Promise<void>>(async () => Promise.resolve())
    const wrapped = processor({ forceFlush: wrappedForceFlush })
    const console = processor({ forceFlush: vi.fn<() => Promise<void>>(async () => Promise.reject(consoleError)) })

    await expect(new LogfireSpanProcessor(wrapped, console).forceFlush()).rejects.toBe(consoleError)
    expect(wrappedForceFlush).toHaveBeenCalledOnce()
  })

  it('reports both failures together when console and batch both reject', async () => {
    const consoleError = new Error('console shutdown failed')
    const batchError = new Error('batch shutdown failed')
    const wrapped = processor({ shutdown: vi.fn<() => Promise<void>>(async () => Promise.reject(batchError)) })
    const console = processor({ shutdown: vi.fn<() => Promise<void>>(async () => Promise.reject(consoleError)) })

    const error: unknown = await new LogfireSpanProcessor(wrapped, console).shutdown().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([consoleError, batchError])
  })

  it('keeps the batch rejection contract without a console processor', async () => {
    const batchError = new Error('batch flush failed')
    const wrapped = processor({ forceFlush: vi.fn<() => Promise<void>>(async () => Promise.reject(batchError)) })

    await expect(new LogfireSpanProcessor(wrapped, undefined).forceFlush()).rejects.toBe(batchError)
  })
})

describe('LogfireSpanProcessor pending spans', () => {
  const pendingSpan = {
    attributes: { 'logfire.span_type': 'pending_span' },
    events: [],
    links: [],
    status: { code: 0 },
  } as unknown as ReadableSpan
  const finishedSpan = {
    attributes: { 'logfire.span_type': 'span' },
    events: [],
    links: [],
    status: { code: 0 },
  } as unknown as ReadableSpan

  function endBoth(options?: { pendingSpans?: boolean }) {
    const wrappedOnEnd = vi.fn<(span: ReadableSpan) => void>()
    const consoleOnEnd = vi.fn<(span: ReadableSpan) => void>()
    const spanProcessor = new LogfireSpanProcessor(processor({ onEnd: wrappedOnEnd }), processor({ onEnd: consoleOnEnd }), options)
    spanProcessor.onEnd(pendingSpan)
    spanProcessor.onEnd(finishedSpan)
    return { consoleSpans: consoleOnEnd.mock.calls.map(([span]) => span), wrappedSpans: wrappedOnEnd.mock.calls.map(([span]) => span) }
  }

  it('forwards pending spans to both processors by default', () => {
    expect(endBoth()).toEqual({ consoleSpans: [pendingSpan, finishedSpan], wrappedSpans: [pendingSpan, finishedSpan] })
  })

  it('keeps pending spans out of the batch processor but not the console with pendingSpans: false', () => {
    expect(endBoth({ pendingSpans: false })).toEqual({ consoleSpans: [pendingSpan, finishedSpan], wrappedSpans: [finishedSpan] })
  })
})
