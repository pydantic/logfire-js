import type { Span, Tracer } from '@opentelemetry/api'
import { context as apiContext, SpanStatusCode, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { setConfig } from '../../src/config'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { instrumentClientFetch, waitUntilTrace } from '../../src/instrumentation/fetch'
import type { ResolvedTraceConfig } from '../../src/types'

apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager())

function createSpan() {
  return {
    end: vitest.fn<() => void>(),
    recordException: vitest.fn<(exception: unknown) => void>(),
    setAttribute: vitest.fn<(key: string, value: unknown) => void>(),
    setAttributes: vitest.fn<(attributes: Record<string, unknown>) => void>(),
    setStatus: vitest.fn<(status: { code: SpanStatusCode }) => void>(),
  }
}

function mockTracer(span: Span) {
  return {
    async startActiveSpan(_name: string, ...args: unknown[]) {
      const fn = args.at(-1) as (span: Span) => Promise<unknown>
      return fn(span)
    },
  } as unknown as Tracer
}

describe('waitUntilTrace', () => {
  it('records errors and ends the span when traced background work rejects', async () => {
    const error = new Error('background work failed')
    const span = createSpan()
    const tracer = mockTracer(span as unknown as Span)
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)

    try {
      await expect(waitUntilTrace(async () => Promise.reject(error))).rejects.toBe(error)
      expect(span.recordException).toHaveBeenCalledWith(error)
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
      expect(span.end).toHaveBeenCalledTimes(1)
    } finally {
      getTracer.mockRestore()
    }
  })
})

describe('instrumentClientFetch', () => {
  it('records errors and ends the span when outbound fetch rejects', async () => {
    const error = new Error('fetch failed')
    const span = createSpan()
    const tracer = mockTracer(span as unknown as Span)
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)
    const fetcher = vitest.fn<(request: Request) => Promise<Response>>(async () => Promise.reject(error))
    const instrumentedFetch = instrumentClientFetch(fetcher as unknown as Fetcher['fetch'], (config) => config.fetch)
    const activeContext = setConfig({ fetch: { includeTraceContext: false } } as ResolvedTraceConfig)

    try {
      await apiContext.with(activeContext, async () => {
        await expect(instrumentedFetch('https://example.com')).rejects.toBe(error)
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(span.recordException).toHaveBeenCalledWith(error)
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
      expect(span.end).toHaveBeenCalledTimes(1)
    } finally {
      getTracer.mockRestore()
    }
  })
})
