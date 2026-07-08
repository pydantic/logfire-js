/// <reference types="@cloudflare/workers-types" />

import type { Span, SpanOptions, Tracer, SpanStatusCode } from '@opentelemetry/api'
import { context as apiContext, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { setConfig } from '../../src/config'
import { AsyncLocalStorageContextManager } from '../../src/context'
import type { ResolvedTraceConfig } from '../../src/types'
import { executeDOFetch, instrumentDOClass } from '../../src/instrumentation/do'

apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager())

type FetchWithRequest = (request: Request) => Response | Promise<Response>

const durableObjectId = {
  toString: () => 'test-durable-object-id',
  equals: () => false,
  name: 'test-object',
} satisfies DurableObjectId

const noop = () => undefined

interface TestDurableObjectState extends DurableObjectState {
  waitUntilPromises: Promise<unknown>[]
}

function createDurableObjectState(): TestDurableObjectState {
  const waitUntilPromises: Promise<unknown>[] = []

  return {
    id: durableObjectId,
    storage: {},
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise)
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback()
    },
    acceptWebSocket: noop,
    getWebSockets() {
      return []
    },
    setWebSocketAutoResponse: noop,
    getWebSocketAutoResponse() {
      return null
    },
    getWebSocketAutoResponseTimestamp() {
      return null
    },
    setHibernatableWebSocketEventTimeout: noop,
    getHibernatableWebSocketEventTimeout() {
      return null
    },
    getTags() {
      return []
    },
    abort: noop,
    props: {},
    facets: {},
    waitUntilPromises,
  } as unknown as TestDurableObjectState
}

const resolvedConfig = {} as ResolvedTraceConfig

function createSpan() {
  return {
    attributes: {} as Record<string, unknown>,
    end: vitest.fn<() => void>(),
    recordException: vitest.fn<(exception: unknown) => void>(),
    setAttribute: vitest.fn<(key: string, value: unknown) => void>(),
    setAttributes: vitest.fn<(attributes: Record<string, unknown>) => void>(),
    setStatus: vitest.fn<(status: { code: SpanStatusCode }) => void>(),
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

class CustomMethodDurableObject implements DurableObject {
  count = 0

  constructor(private readonly state: DurableObjectState) {}

  fetch(): Response {
    this.state.waitUntil(Promise.resolve())
    return new Response()
  }

  increment(delta: number): number {
    this.count += delta
    return this.count
  }

  callFetch(): Response | Promise<Response> {
    return (this.fetch as FetchWithRequest)(new Request('https://example.com'))
  }
}

class LifecycleDurableObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  fetch(): Response {
    this.state.waitUntil(Promise.resolve())
    return new Response()
  }

  alarm(): void {
    return undefined
  }
}

interface CustomMethodDurableObjectInstance extends DurableObject {
  increment(delta: number): number
  callFetch(): Response | Promise<Response>
}

describe('instrumentDOClass', () => {
  it('binds custom Durable Object methods to the instrumented object', async () => {
    const consoleError = vitest.spyOn(console, 'error').mockImplementation(() => undefined)
    const durableObjectState = createDurableObjectState()
    const InstrumentedDurableObject = instrumentDOClass(CustomMethodDurableObject, () => resolvedConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {}) as unknown as CustomMethodDurableObjectInstance

    try {
      const increment = Reflect.get(durableObject, 'increment') as (delta: number) => number

      expect(increment(2)).toBe(2)
      expect(durableObject.increment(3)).toBe(5)

      await durableObject.callFetch()
      expect(durableObjectState.waitUntilPromises).toHaveLength(2)
      await Promise.allSettled(durableObjectState.waitUntilPromises)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('schedules fetch and alarm span export with Durable Object state waitUntil', async () => {
    const consoleError = vitest.spyOn(console, 'error').mockImplementation(() => undefined)
    const durableObjectState = createDurableObjectState()
    const InstrumentedDurableObject = instrumentDOClass(LifecycleDurableObject, () => resolvedConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {})

    try {
      await durableObject.fetch(new Request('https://example.com'))
      const alarm = Reflect.get(durableObject, 'alarm') as () => Promise<void>
      await alarm()

      expect(durableObjectState.waitUntilPromises).toHaveLength(3)
      await Promise.allSettled(durableObjectState.waitUntilPromises)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('executeDOFetch', () => {
  it('uses handler header capture config for Durable Object request and response spans', async () => {
    const span = createSpan()
    let spanOptions: SpanOptions | undefined
    const tracer = mockTracer(span as unknown as Span, (_name, args) => {
      spanOptions = args[0] as SpanOptions
    })
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)
    const fetcher = vitest.fn<FetchWithRequest>(() => {
      return new Response('ok', {
        headers: {
          'Set-Cookie': 'session=secret',
          'X-Do-Response': 'res-1',
        },
      })
    })
    const activeContext = setConfig({
      handlers: {
        fetch: {
          captureHeaders: {
            request: ['x-do-request'],
            response: ['x-do-response'],
          },
        },
      },
    } as unknown as ResolvedTraceConfig)

    try {
      await apiContext.with(activeContext, async () => {
        await executeDOFetch(
          fetcher,
          new Request('https://example.com', {
            headers: {
              Authorization: 'Bearer secret',
              'X-Do-Request': 'req-1',
            },
          }),
          durableObjectId
        )
      })

      expect(spanOptions?.attributes).toMatchObject({
        'http.request.header.x-do-request': ['req-1'],
      })
      expect(spanOptions?.attributes).not.toHaveProperty('http.request.header.authorization')
      expect(span.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          'http.response.header.x-do-response': ['res-1'],
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
