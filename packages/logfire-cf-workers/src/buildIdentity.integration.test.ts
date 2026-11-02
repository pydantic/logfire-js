/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { instrumentInProcess } from './index'

interface OtlpAttribute {
  key: string
  value: { stringValue?: string }
}

interface OtlpExport {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] }
    scopeSpans: { spans: { attributes: OtlpAttribute[]; events?: { attributes: OtlpAttribute[]; name: string }[]; name: string }[] }[]
  }[]
}

// Stands in for what the inject snippet writes when a bundle loads.
function setGlobal(name: '_debugIds' | '_logfireDebugIds' | '_logfireRelease', value: unknown): void {
  Reflect.set(globalThis, name, value)
}
// Wrangler bundles a Worker into one module, which the runtime names without a scheme.
const BUNDLE = 'index.js'
const DEBUG_ID = '0b5e1d1e-7c0a-4c55-9a3e-2f1d0c9b8a71'
const REGISTRY_KEY = `Error\n    at ${BUNDLE}:1:34`
const EXPECTED = `{"${BUNDLE}":"${DEBUG_ID}"}`

function stringAttribute(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attributes?.find((attribute) => attribute.key === key)?.value.stringValue
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, '_logfireDebugIds')
  Reflect.deleteProperty(globalThis, '_logfireRelease')
})

describe('workers build identity', () => {
  it('exports debug IDs and the injected release on a failing fetch handler span', async () => {
    setGlobal('_logfireDebugIds', { [REGISTRY_KEY]: DEBUG_ID })
    setGlobal('_logfireRelease', '9f3c2ab')
    const exports: OtlpExport[] = []
    // Workers runtime globals the SDK uses, which Node lacks.
    vi.stubGlobal('caches', { default: {}, open: async () => Promise.resolve({}) })
    vi.stubGlobal('scheduler', {
      wait: async (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms)
        }),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) => {
        exports.push(JSON.parse(init?.body as string) as OtlpExport)
        return Promise.resolve(new Response('{}'))
      })
    )
    const handler = instrumentInProcess<ExportedHandler>(
      {
        fetch: () => {
          const error = new Error('upstream failed')
          error.stack = `Error: upstream failed\n    at Object.fetch (${BUNDLE}:12:11)`
          throw error
        },
      },
      { service: { name: 'build-identity-worker' } }
    )
    const pending: Promise<unknown>[] = []
    const ctx = {
      passThroughOnException: () => undefined,
      props: {},
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise)
      },
    } as unknown as ExecutionContext

    await expect(
      handler.fetch?.(
        new Request('https://worker.example/charge') as Parameters<NonNullable<ExportedHandler['fetch']>>[0],
        { LOGFIRE_TOKEN: 'token' },
        ctx
      )
    ).rejects.toThrow('upstream failed')
    await Promise.all(pending)

    const [resourceSpans] = exports.flatMap((exported) => exported.resourceSpans)
    const spans = resourceSpans?.scopeSpans.flatMap((scope) => scope.spans) ?? []
    expect(stringAttribute(resourceSpans?.resource.attributes, 'service.version')).toBe('9f3c2ab')
    expect(
      spans.map((span) => ({
        event: stringAttribute(span.events?.find((event) => event.name === 'exception')?.attributes, 'logfire.debug_ids'),
        span: stringAttribute(span.attributes, 'logfire.debug_ids'),
      }))
    ).toEqual([{ event: EXPECTED, span: EXPECTED }])
  })
})
