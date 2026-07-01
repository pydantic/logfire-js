/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from 'vitest'
import type { ResolvedTraceConfig } from '../../src/types'
import { instrumentDOClass } from '../../src/instrumentation/do'

const durableObjectId = {
  toString: () => 'test-durable-object-id',
  equals: () => false,
  name: 'test-object',
} satisfies DurableObjectId

const noop = () => undefined

const durableObjectState = {
  id: durableObjectId,
  storage: {},
  waitUntil: noop,
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
} as unknown as DurableObjectState

class CustomMethodDurableObject implements DurableObject {
  count = 0

  fetch(): Response {
    return new Response()
  }

  increment(delta: number): number {
    this.count += delta
    return this.count
  }
}

interface CustomMethodDurableObjectInstance extends DurableObject {
  increment(delta: number): number
}

describe('instrumentDOClass', () => {
  it('binds custom Durable Object methods to the original object', () => {
    const InstrumentedDurableObject = instrumentDOClass(CustomMethodDurableObject, () => ({}) as ResolvedTraceConfig)
    const durableObject = new InstrumentedDurableObject(durableObjectState, {}) as unknown as CustomMethodDurableObjectInstance

    const increment = Reflect.get(durableObject, 'increment') as (delta: number) => number

    expect(increment(2)).toBe(2)
    expect(durableObject.increment(3)).toBe(5)
  })
})
