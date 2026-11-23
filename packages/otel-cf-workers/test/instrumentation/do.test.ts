/// <reference types="@cloudflare/workers-types" />

import type { Span, SpanOptions, Tracer, SpanStatusCode } from '@opentelemetry/api'
import { context as apiContext, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { getActiveConfig, setConfig } from '../../src/config'
import { AsyncLocalStorageContextManager } from '../../src/context'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { ResolvedTraceConfig } from '../../src/types'
import type { DOClass } from '../../src/instrumentation/do'
import { executeDOFetch, instrumentDOBinding, instrumentDOClass } from '../../src/instrumentation/do'
import { isWrapped, unwrap } from '../../src/wrap'

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

const resolvedConfig = { spanProcessors: [] } as unknown as ResolvedTraceConfig

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
        ;(span as Span & { attributes: Record<string, unknown> }).attributes = options.attributes
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
  it('runs custom Durable Object methods against the uninstrumented object, each in its own invocation', async () => {
    const consoleError = vitest.spyOn(console, 'error').mockImplementation(() => undefined)
    const durableObjectState = createDurableObjectState()
    const InstrumentedDurableObject = instrumentDOClass(CustomMethodDurableObject, () => resolvedConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {}) as unknown as CustomMethodDurableObjectInstance

    try {
      const increment = Reflect.get(durableObject, 'increment')

      expect(increment(2)).toBe(2)
      expect(durableObject.increment(3)).toBe(5)

      await durableObject.callFetch()
      // One span export per method call (increment twice, callFetch once) plus fetch's own waitUntil.
      expect(durableObjectState.waitUntilPromises).toHaveLength(4)
      await Promise.allSettled(durableObjectState.waitUntilPromises)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('schedules fetch and alarm span export with Durable Object state waitUntil', async () => {
    const consoleError = vitest.spyOn(console, 'error').mockImplementation(() => undefined)
    const durableObjectState = createDurableObjectState()
    const InstrumentedDurableObject = instrumentDOClass(LifecycleDurableObject, () => resolvedConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {}) as DurableObject

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

// A bound function reports `[native code]`, which stands in for the workerd `DurableObject` base
// class and its check that the constructor receives the runtime's own state object.
function createNativeDurableObjectBase(expectedState: DurableObjectState) {
  class Base {
    ctx: DurableObjectState
    env: unknown
    constructor(state: DurableObjectState, env: unknown) {
      if (state !== expectedState) {
        throw new TypeError("Failed to construct 'DurableObjectBase': constructor parameter 1 is not of type 'DurableObjectState'.")
      }
      this.ctx = state
      this.env = env
    }
  }
  const NativeBase: typeof Base = Base.bind(null)
  Object.defineProperty(NativeBase, 'prototype', { value: Base.prototype })
  return NativeBase
}

describe('instrumentDOClass with a class that extends DurableObject', () => {
  it('constructs with the raw state and exposes the instrumented state and env as ctx and env', () => {
    const durableObjectState = createDurableObjectState()
    const env = { SECRET: 'value' }
    class ExtendsDurableObject extends createNativeDurableObjectBase(durableObjectState) {
      seenInConstructor: DurableObjectState
      constructor(state: DurableObjectState, constructorEnv: unknown) {
        super(state, constructorEnv)
        this.seenInConstructor = this.ctx
      }
      fetch(): Response {
        return new Response()
      }
    }
    const InstrumentedDurableObject = instrumentDOClass(ExtendsDurableObject as unknown as DOClass, () => resolvedConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, env) as unknown as ExtendsDurableObject

    expect(durableObject.seenInConstructor).toBe(durableObjectState)
    expect(durableObject.ctx).not.toBe(durableObjectState)
    expect(unwrap(durableObject.ctx)).toBe(durableObjectState)
    expect(durableObject.env).not.toBe(env)
    expect(unwrap(durableObject.env as object)).toBe(env)
  })

  it('runs RPC methods with the config active and exports their spans', async () => {
    vitest.stubGlobal('scheduler', { wait: async () => Promise.resolve() })
    const durableObjectState = createDurableObjectState()
    const rpcProcessor = {
      forceFlush: vitest.fn<() => Promise<void>>(async () => Promise.resolve()),
      onEnd: vitest.fn<() => void>(),
      onStart: vitest.fn<() => void>(),
      shutdown: vitest.fn<() => Promise<void>>(async () => Promise.resolve()),
    } satisfies SpanProcessor
    const rpcConfig = { spanProcessors: [rpcProcessor] } as unknown as ResolvedTraceConfig
    class RpcDurableObject extends createNativeDurableObjectBase(durableObjectState) {
      async hello(name: string): Promise<{ greeting: string; config: ResolvedTraceConfig | undefined }> {
        await Promise.resolve()
        return { greeting: `hello ${name}`, config: getActiveConfig() }
      }
    }
    const InstrumentedDurableObject = instrumentDOClass(RpcDurableObject as unknown as DOClass, () => rpcConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {}) as unknown as RpcDurableObject

    try {
      const result = await durableObject.hello('bob')
      await Promise.all(durableObjectState.waitUntilPromises)

      expect(result).toEqual({ greeting: 'hello bob', config: rpcConfig })
      expect(rpcProcessor.forceFlush).toHaveBeenCalledTimes(1)
    } finally {
      vitest.unstubAllGlobals()
    }
  })
})

describe('instrumentDOClass span export', () => {
  function spyProcessor() {
    return {
      forceFlush: vitest.fn<() => Promise<void>>(async () => Promise.resolve()),
      onEnd: vitest.fn<() => void>(),
      onStart: vitest.fn<() => void>(),
      shutdown: vitest.fn<() => Promise<void>>(async () => Promise.resolve()),
    } satisfies SpanProcessor
  }

  it('flushes constructor and invocation span processors, and a shared processor only once', async () => {
    vitest.stubGlobal('scheduler', { wait: async () => Promise.resolve() })
    const constructorProcessor = spyProcessor()
    const fetchProcessor = spyProcessor()
    const alarmProcessor = spyProcessor()
    const sharedProcessor = spyProcessor()
    const initialiser = (_env: unknown, trigger: unknown) => {
      const own = trigger instanceof Request ? fetchProcessor : trigger === 'do-alarm' ? alarmProcessor : constructorProcessor
      return { spanProcessors: [own, sharedProcessor] } as unknown as ResolvedTraceConfig
    }
    const durableObjectState = createDurableObjectState()
    const InstrumentedDurableObject = instrumentDOClass(LifecycleDurableObject, initialiser)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {}) as DurableObject

    try {
      await durableObject.fetch(new Request('https://example.com'))
      await Promise.all(durableObjectState.waitUntilPromises)

      expect(constructorProcessor.forceFlush).toHaveBeenCalledTimes(1)
      expect(fetchProcessor.forceFlush).toHaveBeenCalledTimes(1)
      expect(sharedProcessor.forceFlush).toHaveBeenCalledTimes(1)
      expect(alarmProcessor.forceFlush).toHaveBeenCalledTimes(0)

      const alarm = Reflect.get(durableObject, 'alarm') as () => Promise<void>
      await alarm()
      await Promise.all(durableObjectState.waitUntilPromises)

      expect(constructorProcessor.forceFlush).toHaveBeenCalledTimes(2)
      expect(fetchProcessor.forceFlush).toHaveBeenCalledTimes(1)
      expect(alarmProcessor.forceFlush).toHaveBeenCalledTimes(1)
      expect(sharedProcessor.forceFlush).toHaveBeenCalledTimes(2)
    } finally {
      vitest.unstubAllGlobals()
    }
  })
})

describe('instrumentDOBinding', () => {
  it('instruments fetch on stubs from both get and getByName and leaves the stub itself unwrapped', () => {
    // Stands in for a workerd RpcProperty, which only resolves the remote value when awaited.
    const rpcProperty = () => undefined
    Object.defineProperty(rpcProperty, 'constructor', { value: { name: 'RpcProperty' } })
    const createStub = () => ({ id: durableObjectId, fetch: () => new Response(), value: rpcProperty })
    const namespace = {
      idFromName: () => durableObjectId,
      get: createStub,
      getByName: createStub,
    } as unknown as DurableObjectNamespace

    const binding = instrumentDOBinding(namespace, 'COUNTER')

    for (const stub of [binding.get(durableObjectId), binding.getByName('test-object')]) {
      expect(isWrapped(stub)).toBe(false)
      expect(isWrapped(Reflect.get(stub, 'fetch'))).toBe(true)
      expect(Reflect.get(stub, 'value')).toBe(rpcProperty)
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
