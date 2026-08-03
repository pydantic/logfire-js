/// <reference types="@cloudflare/workers-types" />

import type { Span, Tracer } from '@opentelemetry/api'
import { context as apiContext, SpanStatusCode, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { executeEmailHandler } from '../../src/instrumentation/email'
import type { EmailHandlerArgs } from '../../src/instrumentation/email'

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

function mockTracer(span: Span): Tracer {
  return {
    async startActiveSpan(_name: string, ...args: unknown[]) {
      const fn = args.at(-1) as (span: Span) => Promise<unknown>
      return fn(span)
    },
  } as unknown as Tracer
}

function createMessage(): EmailHandlerArgs[0] {
  return {
    from: 'sender@example.com',
    headers: new Headers({ Subject: 'Hello' }),
    raw: new ReadableStream(),
    rawSize: 0,
    to: 'recipient@example.com',
    setReject: () => undefined,
  } as unknown as EmailHandlerArgs[0]
}

function createExecutionContext(): EmailHandlerArgs[2] {
  return {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: () => undefined,
  } as unknown as EmailHandlerArgs[2]
}

describe('executeEmailHandler', () => {
  it('ends the span without an error status when the handler succeeds', async () => {
    const span = createSpan()
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer(span as unknown as Span))
    const emailFn = vitest.fn<() => Promise<void>>().mockResolvedValue(undefined)

    try {
      await executeEmailHandler(emailFn, [createMessage(), {}, createExecutionContext()])

      expect(span.recordException).not.toHaveBeenCalled()
      expect(span.setStatus).not.toHaveBeenCalled()
      expect(span.end).toHaveBeenCalledTimes(1)
    } finally {
      getTracer.mockRestore()
    }
  })

  it('marks the span as an error when the handler throws', async () => {
    const span = createSpan()
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer(span as unknown as Span))
    const error = new Error('email handler boom')
    const emailFn = vitest.fn<() => Promise<void>>().mockRejectedValue(error)

    try {
      await expect(executeEmailHandler(emailFn, [createMessage(), {}, createExecutionContext()])).rejects.toBe(error)

      expect(span.recordException).toHaveBeenCalledWith(error)
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
      expect(span.end).toHaveBeenCalledTimes(1)
    } finally {
      getTracer.mockRestore()
    }
  })
})
