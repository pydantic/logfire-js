/// <reference types="@cloudflare/workers-types/experimental" />

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vitest } from 'vitest'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { instrumentGlobalCache } from '../../src/instrumentation/cache'

const exporter = new InMemorySpanExporter()

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

trace.setGlobalTracerProvider(provider)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

type CacheKey = Request | string | URL
type MatchFn = (key: CacheKey) => Promise<Response | undefined>
interface DefaultCache {
  match: MatchFn
}

const matchMock = vitest.fn<MatchFn>()
const globalWithCaches = globalThis as unknown as { caches: { default: DefaultCache } }

// The global `caches` binding is typed as the DOM CacheStorage here, which has no `default`, so the
// instrumented cache is reached through an explicitly typed view of globalThis instead.
function instrumentedDefaultCache(): DefaultCache {
  globalWithCaches.caches = {
    default: { match: matchMock } as DefaultCache,
    open: vitest.fn<() => Promise<unknown>>(),
  } as unknown as { default: DefaultCache }
  instrumentGlobalCache()
  return globalWithCaches.caches.default
}

beforeEach(() => {
  exporter.reset()
  vitest.resetAllMocks()
})

function matchedSpanUrl(): unknown {
  const spans = exporter.getFinishedSpans()
  expect(spans).toHaveLength(1)
  return spans[0]?.attributes['http.url']
}

describe('cache instrumentation http.url', () => {
  it('records the url for a Request argument', async () => {
    await instrumentedDefaultCache().match(new Request('https://example.com/a?q=1'))
    expect(matchedSpanUrl()).toBe('https://example.com/a?q=1')
  })

  it('records the url for a string argument', async () => {
    await instrumentedDefaultCache().match('https://example.com/b?q=2')
    expect(matchedSpanUrl()).toBe('https://example.com/b?q=2')
  })

  it('records the url for a URL argument', async () => {
    await instrumentedDefaultCache().match(new URL('https://example.com/c?q=3'))
    expect(matchedSpanUrl()).toBe('https://example.com/c?q=3')
  })

  it('omits the url when the key cannot be parsed', async () => {
    await instrumentedDefaultCache().match('not-a-url')
    expect(matchedSpanUrl()).toBeUndefined()
  })
})
