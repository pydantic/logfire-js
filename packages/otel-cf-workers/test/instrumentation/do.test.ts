/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vitest } from 'vitest'
import type { ResolvedTraceConfig } from '../../src/types'
import { instrumentDOClass } from '../../src/instrumentation/do'

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
