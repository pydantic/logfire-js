import type { Exception, SpanOptions } from '@opentelemetry/api'
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { wrap } from '../wrap.js'

type CacheFns = Cache[keyof Cache]

const tracer = trace.getTracer('cache instrumentation')

function sanitiseURL(url: string): string | undefined {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`
  } catch {
    // Never let attribute building break the caller's cache call.
    return undefined
  }
}

/**
 * The Cache methods accept `RequestInfo | URL`, so the key can be a `Request`, a bare string, or a
 * `URL`, and only the first of those carries a `url` property.
 */
function cacheKeyUrl(key: unknown): string | undefined {
  if (typeof key === 'string') {
    return sanitiseURL(key)
  }
  if (key instanceof URL) {
    return sanitiseURL(key.href)
  }
  if (typeof key === 'object' && key !== null) {
    const requestUrl = (key as { url?: unknown }).url
    if (typeof requestUrl === 'string') {
      return sanitiseURL(requestUrl)
    }
  }
  return undefined
}

function instrumentFunction<T extends CacheFns>(fn: T, cacheName: string, op: string): T {
  const handler: ProxyHandler<typeof fn> = {
    async apply(target, thisArg, argArray) {
      const url = cacheKeyUrl(argArray[0])
      const attributes = {
        'cache.name': cacheName,
        'cache.operation': op,
        ...(url !== undefined ? { 'http.url': url } : {}),
      }
      const options: SpanOptions = { kind: SpanKind.CLIENT, attributes }
      return tracer.startActiveSpan(`Cache ${cacheName} ${op}`, options, async (span) => {
        try {
          const result = await Reflect.apply(target, thisArg, argArray)
          if (op === 'match') {
            span.setAttribute('cache.hit', !!result)
          }
          return result
        } catch (error) {
          span.recordException(error as Exception)
          span.setStatus({ code: SpanStatusCode.ERROR })
          throw error
        } finally {
          span.end()
        }
      })
    },
  }
  return wrap(fn, handler)
}

function instrumentCache(cache: Cache, cacheName: string): Cache {
  const handler: ProxyHandler<typeof cache> = {
    get(target, prop) {
      if (prop === 'delete' || prop === 'match' || prop === 'put') {
        const fn = Reflect.get(target, prop).bind(target)
        return instrumentFunction(fn, cacheName, prop)
      } else {
        return Reflect.get(target, prop)
      }
    },
  }
  return wrap(cache, handler)
}

function instrumentOpen(openFn: CacheStorage['open']): CacheStorage['open'] {
  const handler: ProxyHandler<typeof openFn> = {
    async apply(target, thisArg, argArray) {
      const cacheName = argArray[0]
      const cache = await Reflect.apply(target, thisArg, argArray)
      return instrumentCache(cache, cacheName)
    },
  }
  return wrap(openFn, handler)
}

function instrumentGlobalCacheInner(): void {
  const handler: ProxyHandler<typeof caches> = {
    get(target, prop) {
      if (prop === 'default') {
        const cache = target.default
        return instrumentCache(cache, 'default')
      } else if (prop === 'open') {
        const openFn = Reflect.get(target, prop).bind(target)
        return instrumentOpen(openFn)
      } else {
        return Reflect.get(target, prop)
      }
    },
  }
  // @ts-expect-error: Cloudflare exposes caches as writable in Workers at runtime.
  globalThis.caches = wrap(caches, handler)
}

export function instrumentGlobalCache(): void {
  instrumentGlobalCacheInner()
}
