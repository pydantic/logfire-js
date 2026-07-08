/// <reference types="@cloudflare/workers-types" />

import type { Span, Tracer, SpanStatusCode } from '@opentelemetry/api'
import { context as apiContext, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { setConfig } from '../../src/config'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { instrumentServiceBinding } from '../../src/instrumentation/service'
import type { ResolvedTraceConfig } from '../../src/types'

apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager())

function createSpan() {
  return {
    end: vitest.fn<() => void>(),
    recordException: vitest.fn<(exception: unknown) => void>(),
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

describe('instrumentServiceBinding', () => {
  it('uses fetch header capture config for service binding request and response spans', async () => {
    const span = createSpan()
    const tracer = mockTracer(span as unknown as Span)
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)
    const fetcher = {
      fetch: vitest.fn<Fetcher['fetch']>(async () =>
        Promise.resolve(
          new Response('ok', {
            headers: {
              'Set-Cookie': 'session=secret',
              'X-Service-Response': 'res-1',
            },
          })
        )
      ),
    } as unknown as Fetcher
    const service = instrumentServiceBinding(fetcher, 'API')
    const activeContext = setConfig({
      fetch: {
        captureHeaders: {
          request: ['x-service-request'],
          response: ['x-service-response'],
        },
        includeTraceContext: false,
      },
    } as unknown as ResolvedTraceConfig)

    try {
      await apiContext.with(activeContext, async () => {
        await service.fetch('https://example.com', {
          headers: {
            Authorization: 'Bearer secret',
            'X-Service-Request': 'req-1',
          },
        })
      })

      const setAttributesCalls = span.setAttributes.mock.calls.map(([attrs]) => attrs)
      expect(setAttributesCalls).toContainEqual(
        expect.objectContaining({
          'http.request.header.x-service-request': ['req-1'],
        })
      )
      expect(setAttributesCalls).toContainEqual(
        expect.objectContaining({
          'http.response.header.x-service-response': ['res-1'],
        })
      )
      expect(setAttributesCalls).not.toContainEqual(expect.objectContaining({ 'http.request.header.authorization': ['Bearer secret'] }))
      expect(setAttributesCalls).not.toContainEqual(expect.objectContaining({ 'http.response.header.set-cookie': ['session=secret'] }))
    } finally {
      getTracer.mockRestore()
    }
  })
})
