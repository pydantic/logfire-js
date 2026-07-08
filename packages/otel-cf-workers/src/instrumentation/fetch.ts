import type { SpanOptions, Attributes, Exception, Context } from '@opentelemetry/api'
import { trace, SpanKind, propagation, context as api_context, SpanStatusCode } from '@opentelemetry/api'
import type { Initialiser } from '../config.js'
import { getActiveConfig, setConfig } from '../config.js'
import { wrap } from '../wrap.js'
import { instrumentEnv } from './env.js'
import { exportSpans, proxyExecutionContext } from './common.js'
import type { ResolvedTraceConfig } from '../types.js'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { ATTR_FAAS_COLDSTART, ATTR_FAAS_INVOCATION_ID, ATTR_FAAS_TRIGGER } from '../semconv.js'
import { versionAttributes } from './version.js'

export type IncludeTraceContextFn = (request: Request) => boolean
/**
 * Predicate for selecting headers to record as span attributes. The header name
 * is lowercased before this function is called; the value is passed unchanged.
 */
export type HeaderCapturePredicate = (name: string, value: string) => boolean
/**
 * Controls header capture for request/response span attributes.
 *
 * - `true`: capture all headers.
 * - `string[]`: capture only these header names, matched case-insensitively.
 * - function: capture headers when the predicate returns `true`.
 *
 * @default undefined No headers are captured.
 */
export type HeaderCaptureSelector = boolean | readonly string[] | HeaderCapturePredicate
/**
 * Explicit request and response header capture selectors. Header capture is
 * disabled by default to avoid recording sensitive values.
 */
export interface HeaderCaptureConfig {
  request?: HeaderCaptureSelector
  response?: HeaderCaptureSelector
}

export interface FetcherConfig {
  includeTraceContext?: boolean | IncludeTraceContextFn
  /**
   * Explicit header capture for outbound fetch spans.
   */
  captureHeaders?: HeaderCaptureConfig
}

export type AcceptTraceContextFn = (request: Request) => boolean
export interface FetchHandlerConfig {
  /**
   * Whether to enable context propagation for incoming requests to `fetch`.
   * This enables or disables distributed tracing from W3C Trace Context headers.
   * @default true
   */
  acceptTraceContext?: boolean | AcceptTraceContextFn
  /**
   * Explicit header capture for incoming fetch handler spans.
   */
  captureHeaders?: HeaderCaptureConfig
}

type FetchHandler = ExportedHandlerFetchHandler
type FetchHandlerArgs = Parameters<FetchHandler>

const netKeysFromCF = new Set(['colo', 'country', 'request_priority', 'tls_cipher', 'tls_version', 'asn', 'tcp_rtt'])

const camelToSnakeCase = (s: string): string => {
  return s.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)
}

const gatherOutgoingCfAttributes = (cf: RequestInitCfProperties): Attributes => {
  const attrs: Record<string, string | number> = {}
  Object.keys(cf).forEach((key) => {
    const value = cf[key]
    const destKey = camelToSnakeCase(key)
    if (!netKeysFromCF.has(destKey)) {
      if (typeof value === 'string' || typeof value === 'number') {
        attrs[`cf.${destKey}`] = value
      } else {
        attrs[`cf.${destKey}`] = JSON.stringify(value)
      }
    }
  })
  return attrs
}

function shouldCaptureHeader(selector: HeaderCaptureSelector | undefined, name: string, value: string): boolean {
  if (selector === undefined || selector === false) {
    return false
  }

  if (selector === true) {
    return true
  }

  if (typeof selector === 'function') {
    return selector(name, value)
  }

  return selector.some((headerName) => headerName.toLowerCase() === name)
}

function gatherHeaderAttributes(
  attrs: Attributes,
  headers: Headers,
  prefix: 'http.request.header' | 'http.response.header',
  selector?: HeaderCaptureSelector
): void {
  for (const [rawKey, value] of headers.entries()) {
    const key = rawKey.toLowerCase()
    if (shouldCaptureHeader(selector, key, value)) {
      const attrKey = `${prefix}.${key}`
      const existingValue = attrs[attrKey]
      const existingValues = Array.isArray(existingValue) ? existingValue.filter((item): item is string => typeof item === 'string') : []
      attrs[attrKey] = [...existingValues, value]
    }
  }
}

export function gatherRequestAttributes(request: Request, captureHeaders?: HeaderCaptureSelector): Attributes {
  const attrs: Attributes = {}
  const headers = request.headers
  attrs['http.request.method'] = request.method.toUpperCase()
  attrs['network.protocol.name'] = 'http'
  if (typeof request.cf?.httpProtocol === 'string') {
    attrs['network.protocol.version'] = request.cf.httpProtocol
  }
  const contentLength = headers.get('content-length')
  if (contentLength !== null) {
    attrs['http.request.body.size'] = contentLength
  }
  const userAgent = headers.get('user-agent')
  if (userAgent !== null) {
    attrs['user_agent.original'] = userAgent
  }
  const contentType = headers.get('content-type')
  if (contentType !== null) {
    attrs['http.mime_type'] = contentType
  }
  if (typeof request.cf?.clientAcceptEncoding === 'string') {
    attrs['http.accepts'] = request.cf.clientAcceptEncoding
  }

  gatherHeaderAttributes(attrs, headers, 'http.request.header', captureHeaders)

  const u = new URL(request.url)
  attrs['url.full'] = `${u.protocol}//${u.host}${u.pathname}${u.search}`
  attrs['server.address'] = u.host
  attrs['url.scheme'] = u.protocol
  attrs['url.path'] = u.pathname
  attrs['url.query'] = u.search

  return attrs
}

export function gatherResponseAttributes(response: Response, captureHeaders?: HeaderCaptureSelector): Attributes {
  const attrs: Attributes = {}
  attrs['http.response.status_code'] = response.status
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    attrs['http.response.body.size'] = contentLength
  }
  const contentType = response.headers.get('content-type')
  if (contentType !== null) {
    attrs['http.mime_type'] = contentType
  }

  gatherHeaderAttributes(attrs, response.headers, 'http.response.header', captureHeaders)
  return attrs
}

export function gatherIncomingCfAttributes(request: Request): Attributes {
  const attrs: Record<string, string | number> = {}
  attrs['net.colo'] = request.cf?.colo as string
  attrs['net.country'] = request.cf?.country as string
  attrs['net.request_priority'] = request.cf?.requestPriority as string
  attrs['net.tls_cipher'] = request.cf?.tlsCipher as string
  attrs['net.tls_version'] = request.cf?.tlsVersion as string
  attrs['net.asn'] = request.cf?.asn as number
  attrs['net.tcp_rtt'] = request.cf?.clientTcpRtt as number
  return attrs
}

export function getParentContextFromHeaders(headers: Headers): Context {
  return propagation.extract(api_context.active(), headers, {
    get(headers, key) {
      return headers.get(key) ?? undefined
    },
    keys(headers) {
      return [...headers.keys()]
    },
  })
}

function getParentContextFromRequest(request: Request): Context {
  const workerConfig = getActiveConfig()

  if (workerConfig === undefined) {
    return api_context.active()
  }

  const acceptTraceContext =
    typeof workerConfig.handlers.fetch.acceptTraceContext === 'function'
      ? workerConfig.handlers.fetch.acceptTraceContext(request)
      : (workerConfig.handlers.fetch.acceptTraceContext ?? true)
  return acceptTraceContext ? getParentContextFromHeaders(request.headers) : api_context.active()
}

export async function waitUntilTrace(fn: () => Promise<unknown>): Promise<void> {
  const tracer = trace.getTracer('waitUntil')
  return tracer.startActiveSpan('waitUntil', async (span) => {
    try {
      await fn()
    } catch (error) {
      span.recordException(error as Exception)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })
}

let cold_start = true
export async function executeFetchHandler(fetchFn: FetchHandler, [request, env, ctx]: FetchHandlerArgs): Promise<Response> {
  const spanContext = getParentContextFromRequest(request)
  const captureHeaders = getActiveConfig()?.handlers?.fetch?.captureHeaders

  const tracer = trace.getTracer('fetchHandler')
  const attributes = {
    [ATTR_FAAS_TRIGGER]: 'http',
    [ATTR_FAAS_COLDSTART]: cold_start,
    [ATTR_FAAS_INVOCATION_ID]: request.headers.get('cf-ray') ?? undefined,
  }
  cold_start = false
  Object.assign(attributes, gatherRequestAttributes(request, captureHeaders?.request))
  Object.assign(attributes, gatherIncomingCfAttributes(request))
  Object.assign(attributes, versionAttributes(env))
  const options: SpanOptions = {
    attributes,
    kind: SpanKind.SERVER,
  }

  const method = request.method.toUpperCase()
  const promise = tracer.startActiveSpan(`fetchHandler ${method}`, options, spanContext, async (span) => {
    const readable = span as unknown as ReadableSpan
    try {
      const response = await fetchFn(request, env, ctx)
      span.setAttributes(gatherResponseAttributes(response, captureHeaders?.response))

      return response
    } catch (error) {
      span.recordException(error as Exception)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      if (readable.attributes['http.route']) {
        span.updateName(`fetchHandler ${method} ${readable.attributes['http.route']}`)
      } else if (readable.attributes['url.path']) {
        span.updateName(`fetchHandler ${method} ${readable.attributes['url.path']}`)
      }
      span.end()
    }
  })
  return promise
}

export function createFetchHandler(fetchFn: FetchHandler, initialiser: Initialiser): FetchHandler {
  const fetchHandler: ProxyHandler<FetchHandler> = {
    apply: async (target, _thisArg, argArray: Parameters<FetchHandler>): Promise<Response> => {
      const [request, orig_env, orig_ctx] = argArray
      const config = initialiser(orig_env as Record<string, unknown>, request)
      const env = instrumentEnv(orig_env as Record<string, unknown>)
      const { ctx, tracker } = proxyExecutionContext(orig_ctx)
      const context = setConfig(config)

      try {
        const args: FetchHandlerArgs = [request, env, ctx]
        return await api_context.with(context, executeFetchHandler, undefined, target, args)
      } finally {
        orig_ctx.waitUntil(exportSpans(tracker))
      }
    },
  }
  return wrap(fetchFn, fetchHandler)
}

type getFetchConfig = (config: ResolvedTraceConfig) => FetcherConfig
export function instrumentClientFetch(fetchFn: Fetcher['fetch'], configFn: getFetchConfig, attrs?: Attributes): Fetcher['fetch'] {
  const handler: ProxyHandler<Fetcher['fetch']> = {
    apply: (target, thisArg, argArray): Response | Promise<Response> => {
      const request = new Request(argArray[0], argArray[1])
      if (!request.url.startsWith('http')) {
        return Reflect.apply(target, thisArg, argArray)
      }

      const workerConfig = getActiveConfig()
      if (!workerConfig) {
        return Reflect.apply(target, thisArg, [request])
      }
      const config = configFn(workerConfig)

      const tracer = trace.getTracer('fetcher')
      const options: SpanOptions = { kind: SpanKind.CLIENT, ...(attrs !== undefined ? { attributes: attrs } : {}) }

      const host = new URL(request.url).host
      const method = request.method.toUpperCase()
      const spanName = typeof attrs?.['name'] === 'string' ? attrs?.['name'] : `fetch ${method} ${host}`
      const promise = tracer.startActiveSpan(spanName, options, async (span) => {
        try {
          const includeTraceContext =
            typeof config.includeTraceContext === 'function' ? config.includeTraceContext(request) : config.includeTraceContext
          if (includeTraceContext ?? true) {
            propagation.inject(api_context.active(), request.headers, {
              set: (h, k, v) => {
                h.set(k, typeof v === 'string' ? v : String(v))
              },
            })
          }
          span.setAttributes(gatherRequestAttributes(request, config.captureHeaders?.request))
          if (request.cf) {
            span.setAttributes(gatherOutgoingCfAttributes(request.cf))
          }
          const response = await Reflect.apply(target, thisArg, [request])
          span.setAttributes(gatherResponseAttributes(response, config.captureHeaders?.response))
          return response
        } catch (error) {
          span.recordException(error as Exception)
          span.setStatus({ code: SpanStatusCode.ERROR })
          throw error
        } finally {
          span.end()
        }
      })
      return promise
    },
  }
  return wrap(fetchFn, handler, true)
}

export function instrumentGlobalFetch(): void {
  globalThis.fetch = instrumentClientFetch(globalThis.fetch, (config) => config.fetch)
}
