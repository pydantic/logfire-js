/// <reference types="@cloudflare/workers-types/experimental" />

import { describe, expect, it, vitest } from 'vitest'
import { instrumentEnv } from '../../src/instrumentation/env'

// The binding detectors are not exported, so each case is driven through `instrumentEnv` and
// identified by the span-producing methods the returned proxy exposes.
function bindings(env: Record<string, unknown>): Record<string, unknown> {
  return instrumentEnv(env)
}

describe('instrumentEnv binding detection', () => {
  it('passes through values that cannot be proxied', () => {
    const env = bindings({ COUNT: 3, FLAG: true, SECRET: 'shh' })

    expect(env.COUNT).toBe(3)
    expect(env.FLAG).toBe(true)
    expect(env.SECRET).toBe('shh')
  })

  it('leaves version metadata untouched so accesses are not traced', () => {
    const metadata = { id: 'version-id', tag: 'version-tag' }
    const env = bindings({ CF_VERSION_METADATA: metadata })

    expect(env.CF_VERSION_METADATA).toBe(metadata)
  })

  it('wraps a KV namespace, keeping its methods callable', () => {
    const get = vitest.fn<() => Promise<null>>().mockResolvedValue(null)
    const env = bindings({ MY_KV: { get, getWithMetadata: vitest.fn<() => Promise<null>>() } })
    const kv = env.MY_KV as { get: (key: string) => Promise<null> }

    expect(kv.get).not.toBe(get)
    expect(typeof kv.get).toBe('function')
  })

  it('wraps a queue, distinguishing it from a KV namespace by sendBatch', () => {
    const send = vitest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const env = bindings({ MY_QUEUE: { send, sendBatch: vitest.fn<() => Promise<void>>() } })
    const queue = env.MY_QUEUE as { send: (body: unknown) => Promise<void> }

    expect(queue.send).not.toBe(send)
    expect(typeof queue.send).toBe('function')
  })

  it('wraps a Durable Object namespace, detected by idFromName', () => {
    const idFromName = vitest.fn<() => unknown>()
    const env = bindings({ MY_DO: { get: vitest.fn<() => unknown>(), idFromName } })
    const namespace = env.MY_DO as { idFromName: (name: string) => unknown }

    expect(typeof namespace.idFromName).toBe('function')
  })

  it('wraps an Analytics Engine dataset, detected by writeDataPoint', () => {
    const writeDataPoint = vitest.fn<() => void>()
    const env = bindings({ MY_AE: { writeDataPoint } })
    const dataset = env.MY_AE as { writeDataPoint: (point: unknown) => void }

    expect(dataset.writeDataPoint).not.toBe(writeDataPoint)
    expect(typeof dataset.writeDataPoint).toBe('function')
  })

  it('wraps a D1 database, detected by exec together with prepare', () => {
    const env = bindings({ MY_DB: { exec: vitest.fn<() => unknown>(), prepare: vitest.fn<() => unknown>() } })
    const database = env.MY_DB as { prepare: (sql: string) => unknown }

    expect(typeof database.prepare).toBe('function')
  })

  it('leaves an object alone when it matches no binding shape', () => {
    const plain = { someMethod: vitest.fn<() => void>() }
    const env = bindings({ PLAIN: plain })
    const result = env.PLAIN as { someMethod: unknown }

    expect(typeof result.someMethod).toBe('function')
  })
})
