/// <reference types="@cloudflare/workers-types/experimental" />

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vitest } from 'vitest'
import { context as apiContext, trace } from '@opentelemetry/api'
import { setConfig } from '../../src/config'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { instrumentEnv } from '../../src/instrumentation/env'
import type { ResolvedTraceConfig } from '../../src/types'

const exporter = new InMemorySpanExporter()

trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))
apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager())

beforeEach(() => {
  exporter.reset()
})

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

  it('wraps a KV namespace, keeping its methods callable', async () => {
    const get = vitest.fn<() => Promise<string>>().mockResolvedValue('value')
    const env = bindings({ MY_KV: { get, getWithMetadata: vitest.fn<() => Promise<null>>() } })
    const kv = env.MY_KV as { get: (key: string) => Promise<string> }

    expect(kv.get).not.toBe(get)
    await expect(kv.get('key')).resolves.toBe('value')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('wraps a queue, distinguishing it from a KV namespace by sendBatch', async () => {
    const send = vitest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const env = bindings({ MY_QUEUE: { send, sendBatch: vitest.fn<() => Promise<void>>() } })
    const queue = env.MY_QUEUE as { send: (body: unknown) => Promise<void> }

    expect(queue.send).not.toBe(send)
    await queue.send('body')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('wraps a Durable Object namespace, detected by idFromName', () => {
    const id = { name: 'instance' }
    const idFromName = vitest.fn<() => unknown>().mockReturnValue(id)
    const env = bindings({ MY_DO: { get: vitest.fn<() => unknown>(), idFromName } })
    const namespace = env.MY_DO as { idFromName: (name: string) => unknown }

    expect(namespace.idFromName('instance')).toBe(id)
    expect(idFromName).toHaveBeenCalledWith('instance')
  })

  it('wraps an Analytics Engine dataset, detected by writeDataPoint', async () => {
    const writeDataPoint = vitest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const env = bindings({ MY_AE: { writeDataPoint } })
    const dataset = env.MY_AE as { writeDataPoint: (point: unknown) => Promise<void> }

    expect(dataset.writeDataPoint).not.toBe(writeDataPoint)
    await dataset.writeDataPoint({ indexes: ['idx'] })
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
  })

  it('wraps a D1 database, detected by exec together with prepare', () => {
    const statement = { bind: vitest.fn<() => unknown>() }
    const prepare = vitest.fn<() => unknown>().mockReturnValue(statement)
    const env = bindings({ MY_DB: { exec: vitest.fn<() => unknown>(), prepare } })
    const database = env.MY_DB as { prepare: (sql: string) => unknown }

    // D1 wraps the returned statement, so the instrumented call does not hand back the raw one.
    expect(database.prepare('select 1')).not.toBe(statement)
    expect(prepare).toHaveBeenCalledWith('select 1')
  })

  it('wraps a service binding, which is detected before every other shape', async () => {
    // A JS RPC stub answers every property access, so it has to be recognised first or it would
    // match the KV, queue and D1 shapes as well.
    const fetch = vitest.fn<() => Promise<Response>>().mockResolvedValue(new Response('ok'))
    const rpcStub = new Proxy({ fetch } as Record<string, unknown>, {
      // An RPC stub answers arbitrary method names, but symbol lookups such as the internal
      // wrap marker still have to come back undefined.
      get: (target, prop): unknown => {
        if (typeof prop === 'symbol') {
          return undefined
        }
        return prop in target ? target[prop] : vitest.fn<() => void>()
      },
    })
    const env = bindings({ MY_SERVICE: rpcStub })
    const service = env.MY_SERVICE as { fetch: (url: string) => Promise<Response> }

    const active = setConfig({ fetch: { includeTraceContext: true } } as unknown as ResolvedTraceConfig)
    await apiContext.with(active, async () => {
      await service.fetch('https://example.com/')
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    // Only the service-binding branch names the span this way, so this pins `isJSRPC` being
    // checked ahead of the KV, queue and D1 shapes that an RPC stub also satisfies.
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['Service Binding MY_SERVICE'])
  })

  it('leaves an object alone when it matches no binding shape', () => {
    const plain = { someMethod: vitest.fn<() => void>() }
    const env = bindings({ PLAIN: plain })

    expect(env.PLAIN).toBe(plain)
  })
})
