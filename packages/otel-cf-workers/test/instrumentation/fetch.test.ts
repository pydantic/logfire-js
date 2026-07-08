import type { Span, SpanOptions, Tracer } from '@opentelemetry/api'
import { context as apiContext, SpanStatusCode, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { setConfig } from '../../src/config'
import { AsyncLocalStorageContextManager } from '../../src/context'
import {
  executeFetchHandler,
  gatherRequestAttributes,
  gatherResponseAttributes,
  instrumentClientFetch,
  waitUntilTrace,
} from '../../src/instrumentation/fetch'
import type { ResolvedTraceConfig } from '../../src/types'

apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager())

function createSpan() {
  return {
    attributes: {} as Record<string, unknown>,
    end: vitest.fn<() => void>(),
    recordException: vitest.fn<(exception: unknown) => void>(),
    setAttribute: vitest.fn<(key: string, value: unknown) => void>(),
    setAttributes: vitest.fn<(attributes: Record<string, unknown>) => void>(),
    setStatus: vitest.fn<(status: { code: SpanStatusCode }) => void>(),
    updateName: vitest.fn<(name: string) => void>(),
  }
}

function mockTracer(span: Span, onStart?: (name: string, args: unknown[]) => void) {
  return {
    async startActiveSpan(name: string, ...args: unknown[]) {
      onStart?.(name, args)
      const options = args.find((arg): arg is SpanOptions => typeof arg === 'object' && arg !== null && 'attributes' in arg)
      if (options?.attributes) {
        ;(span as Span & { attributes: Record<string, unknown> }).attributes = options.attributes as Record<string, unknown>
      }
      const fn = args.at(-1) as (span: Span) => Promise<unknown>
      return fn(span)
    },
  } as unknown as Tracer
}

function createExecutionContext(): ExecutionContext {
  return {
    passThroughOnException: vitest.fn<() => void>(),
    props: {},
    waitUntil: vitest.fn<(promise: Promise<unknown>) => void>(),
  } as unknown as ExecutionContext
}

describe('gatherRequestAttributes', () => {
  it('does not capture request headers by default', () => {
    const request = new Request('https://example.com/path?query=1', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'Content-Type': 'application/json',
        'User-Agent': 'test-agent',
        'X-Request-Id': 'req-1',
      },
      method: 'POST',
    })

    const attrs = gatherRequestAttributes(request)

    expect(attrs).toMatchObject({
      'http.mime_type': 'application/json',
      'http.request.method': 'POST',
      'user_agent.original': 'test-agent',
      'url.path': '/path',
      'url.query': '?query=1',
    })
    expect(attrs).not.toHaveProperty('http.request.header.authorization')
    expect(attrs).not.toHaveProperty('http.request.header.cookie')
    expect(attrs).not.toHaveProperty('http.request.header.x-request-id')
  })

  it('captures selected request headers as arrays', () => {
    const request = new Request('https://example.com', {
      headers: {
        Authorization: 'Bearer secret',
        'X-Request-Id': 'req-1',
      },
    })

    const attrs = gatherRequestAttributes(request, ['X-Request-ID'])

    expect(attrs['http.request.header.x-request-id']).toEqual(['req-1'])
    expect(attrs).not.toHaveProperty('http.request.header.authorization')
  })

  it('captures all request headers when explicitly enabled', () => {
    const request = new Request('https://example.com', {
      headers: {
        Authorization: 'Bearer secret',
        'X-Request-Id': 'req-1',
      },
    })

    const attrs = gatherRequestAttributes(request, true)

    expect(attrs['http.request.header.authorization']).toEqual(['Bearer secret'])
    expect(attrs['http.request.header.x-request-id']).toEqual(['req-1'])
  })

  it('captures request headers selected by a predicate', () => {
    const request = new Request('https://example.com', {
      headers: {
        'Cache-Control': 'no-cache',
        'X-Request-Id': 'req-1',
      },
    })

    const attrs = gatherRequestAttributes(request, (name) => name.startsWith('x-'))

    expect(attrs['http.request.header.x-request-id']).toEqual(['req-1'])
    expect(attrs).not.toHaveProperty('http.request.header.cache-control')
  })
})

describe('gatherResponseAttributes', () => {
  it('does not capture response headers by default', () => {
    const response = new Response('ok', {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=secret',
        'X-Response-Id': 'res-1',
      },
      status: 201,
    })

    const attrs = gatherResponseAttributes(response)

    expect(attrs).toMatchObject({
      'http.mime_type': 'application/json',
      'http.response.status_code': 201,
    })
    expect(attrs).not.toHaveProperty('http.response.header.set-cookie')
    expect(attrs).not.toHaveProperty('http.response.header.x-response-id')
  })

  it('captures selected response headers as arrays', () => {
    const response = new Response('ok', {
      headers: {
        'Set-Cookie': 'session=secret',
        'X-Response-Id': 'res-1',
      },
    })

    const attrs = gatherResponseAttributes(response, ['x-response-id'])

    expect(attrs['http.response.header.x-response-id']).toEqual(['res-1'])
    expect(attrs).not.toHaveProperty('http.response.header.set-cookie')
  })
})

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
  it('uses fetch header capture config for outbound request and response spans', async () => {
    const span = createSpan()
    const tracer = mockTracer(span as unknown as Span)
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)
    const fetcher = vitest.fn<(request: Request) => Promise<Response>>(async () => {
      return Promise.resolve(
        new Response('ok', {
          headers: {
            'Set-Cookie': 'session=secret',
            'X-Client-Response': 'res-1',
          },
        })
      )
    })
    const instrumentedFetch = instrumentClientFetch(fetcher as unknown as Fetcher['fetch'], (config) => config.fetch)
    const activeContext = setConfig({
      fetch: {
        captureHeaders: {
          request: ['x-client-request'],
          response: ['x-client-response'],
        },
        includeTraceContext: false,
      },
    } as unknown as ResolvedTraceConfig)

    try {
      await apiContext.with(activeContext, async () => {
        await instrumentedFetch('https://example.com', {
          headers: {
            Authorization: 'Bearer secret',
            'X-Client-Request': 'req-1',
          },
        })
      })

      const setAttributesCalls = span.setAttributes.mock.calls.map(([attrs]) => attrs)
      expect(setAttributesCalls).toContainEqual(
        expect.objectContaining({
          'http.request.header.x-client-request': ['req-1'],
        })
      )
      expect(setAttributesCalls).toContainEqual(
        expect.objectContaining({
          'http.response.header.x-client-response': ['res-1'],
        })
      )
      expect(setAttributesCalls).not.toContainEqual(expect.objectContaining({ 'http.request.header.authorization': ['Bearer secret'] }))
      expect(setAttributesCalls).not.toContainEqual(expect.objectContaining({ 'http.response.header.set-cookie': ['session=secret'] }))
    } finally {
      getTracer.mockRestore()
    }
  })

  it('records errors and ends the span when outbound fetch rejects', async () => {
    const error = new Error('fetch failed')
    const span = createSpan()
    const tracer = mockTracer(span as unknown as Span)
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)
    const fetcher = vitest.fn<(request: Request) => Promise<Response>>(async () => Promise.reject(error))
    const instrumentedFetch = instrumentClientFetch(fetcher as unknown as Fetcher['fetch'], (config) => config.fetch)
    const activeContext = setConfig({ fetch: { includeTraceContext: false } } as unknown as ResolvedTraceConfig)

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

describe('executeFetchHandler', () => {
  it('uses handler header capture config for inbound request and response spans', async () => {
    const span = createSpan()
    let spanOptions: SpanOptions | undefined
    const tracer = mockTracer(span as unknown as Span, (_name, args) => {
      spanOptions = args[0] as SpanOptions
    })
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)
    const fetcher = vitest.fn<ExportedHandlerFetchHandler>(() => {
      return new Response('ok', {
        headers: {
          'Set-Cookie': 'session=secret',
          'X-Handler-Response': 'res-1',
        },
      })
    })
    const activeContext = setConfig({
      handlers: {
        fetch: {
          acceptTraceContext: false,
          captureHeaders: {
            request: ['x-handler-request'],
            response: ['x-handler-response'],
          },
        },
      },
    } as unknown as ResolvedTraceConfig)

    try {
      await apiContext.with(activeContext, async () => {
        await executeFetchHandler(fetcher, [
          new Request('https://example.com', {
            headers: {
              Authorization: 'Bearer secret',
              'X-Handler-Request': 'req-1',
            },
          }) as Parameters<ExportedHandlerFetchHandler>[0],
          {},
          createExecutionContext(),
        ])
      })

      expect(spanOptions?.attributes).toMatchObject({
        'http.request.header.x-handler-request': ['req-1'],
      })
      expect(spanOptions?.attributes).not.toHaveProperty('http.request.header.authorization')
      expect(span.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          'http.response.header.x-handler-response': ['res-1'],
        })
      )
      expect(span.setAttributes).not.toHaveBeenCalledWith(
        expect.objectContaining({ 'http.response.header.set-cookie': ['session=secret'] })
      )
    } finally {
      getTracer.mockRestore()
    }
  })
})
