import { CustomTag } from './types'
import type { ConsoleLevel, ConsolePayload, NavigationPayload, NetworkPayload } from './types'

type Emit = (tag: string, payload: unknown) => void
type OnError = (error: unknown) => void
type Stop = () => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- patching host methods requires preserving arbitrary call signatures.
type AnyFunction = (this: any, ...args: any[]) => unknown

interface CaptureOptions {
  onError?: OnError | undefined
}

interface NetworkCaptureOptions extends CaptureOptions {
  ignoreUrlPatterns: RegExp[]
  now: () => number
  redactUrlPatterns: RegExp[]
}

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug']
const MAX_ARG_LENGTH = 1024
const MAX_ARGS = 10
const noop: Stop = () => undefined

export function captureConsole(emit: Emit, options: CaptureOptions = {}): Stop {
  const stops: Stop[] = []
  try {
    for (const level of CONSOLE_LEVELS) {
      const original = (console as Record<ConsoleLevel, unknown>)[level]
      if (typeof original !== 'function') {
        continue
      }
      stops.push(
        patchMethod(
          console,
          level,
          (originalConsoleMethod, isActive) =>
            function (this: unknown, ...args: unknown[]) {
              if (isActive()) {
                safeEmit(
                  emit,
                  CustomTag.Console,
                  {
                    level,
                    args: args.slice(0, MAX_ARGS).map(stringifyArg),
                  } satisfies ConsolePayload,
                  options.onError
                )
              }
              return originalConsoleMethod.apply(this, args)
            }
        )
      )
    }
    return combineStops(stops)
  } catch (error) {
    stopAll(stops)
    throw error
  }
}

export function captureNetwork(emit: Emit, options: NetworkCaptureOptions): Stop {
  const normalizedOptions = normalizeNetworkCaptureOptions(options)
  const stopFetch = captureFetch(emit, normalizedOptions)
  try {
    const stopXhr = captureXhr(emit, normalizedOptions)
    return combineStops([stopFetch, stopXhr])
  } catch (error) {
    stopFetch()
    throw error
  }
}

export function captureNavigation(emit: Emit, options: CaptureOptions = {}): Stop {
  const emitNavigation = (kind: NavigationPayload['kind']) => {
    safeEmit(emit, CustomTag.Navigation, { url: window.location.href, kind } satisfies NavigationPayload, options.onError)
  }
  const stops: Stop[] = []
  try {
    stops.push(
      patchMethod(
        history,
        'pushState',
        (originalPush, isActive) =>
          function (this: History, ...args: Parameters<History['pushState']>) {
            const result = originalPush.apply(this, args)
            if (isActive()) {
              emitNavigation('push')
            }
            return result
          }
      )
    )
    stops.push(
      patchMethod(
        history,
        'replaceState',
        (originalReplace, isActive) =>
          function (this: History, ...args: Parameters<History['replaceState']>) {
            const result = originalReplace.apply(this, args)
            if (isActive()) {
              emitNavigation('replace')
            }
            return result
          }
      )
    )
    let active = true
    const onPop = () => {
      if (active) {
        emitNavigation('pop')
      }
    }
    window.addEventListener('popstate', onPop)
    stops.push(() => {
      active = false
      window.removeEventListener('popstate', onPop)
    })
    return combineStops(stops)
  } catch (error) {
    stopAll(stops)
    throw error
  }
}

function captureFetch(emit: Emit, options: NetworkCaptureOptions): Stop {
  const original = window.fetch
  if (typeof original !== 'function') {
    return noop
  }
  return patchMethod(
    window,
    'fetch',
    (originalFetch, isActive) =>
      async function (this: Window, input: RequestInfo | URL, init?: RequestInit) {
        const callOriginal = originalFetch as typeof window.fetch
        if (!isActive()) {
          return callOriginal.call(this, input, init)
        }
        const startedAt = options.now()
        const method = getFetchMethod(input, init)
        const rawUrl = getFetchUrl(input)
        if (shouldIgnoreUrl(rawUrl, options.ignoreUrlPatterns)) {
          return callOriginal.call(this, input, init)
        }
        const url = redactUrl(rawUrl, options.redactUrlPatterns)
        const reqBytes = sizeOfBody(init?.body)

        try {
          const response = await callOriginal.call(this, input, init)
          if (isActive()) {
            safeEmit(
              emit,
              CustomTag.Network,
              createNetworkPayload({
                method,
                url,
                status: response.status,
                durationMs: Math.max(0, options.now() - startedAt),
                reqBytes,
                resBytes: contentLength(response.headers),
              }),
              options.onError
            )
          }
          return response
        } catch (error) {
          if (isActive()) {
            safeEmit(
              emit,
              CustomTag.Network,
              createNetworkPayload({
                method,
                url,
                status: 0,
                durationMs: Math.max(0, options.now() - startedAt),
                failed: true,
                reqBytes,
              }),
              options.onError
            )
          }
          throw error
        }
      }
  )
}

function captureXhr(emit: Emit, options: NetworkCaptureOptions): Stop {
  const prototype = window.XMLHttpRequest.prototype
  const states = new WeakMap<XMLHttpRequest, XhrState>()
  const stops: Stop[] = []
  try {
    stops.push(
      patchMethod(
        prototype,
        'open',
        (originalOpen, isActive) =>
          function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
            const [method, url] = args
            if (!isActive()) {
              return originalOpen.apply(this, args)
            }
            const rawUrl = url.toString()
            if (shouldIgnoreUrl(rawUrl, options.ignoreUrlPatterns)) {
              states.delete(this)
              return originalOpen.apply(this, args)
            }
            states.set(this, {
              method: method.toUpperCase(),
              url: redactUrl(rawUrl, options.redactUrlPatterns),
              startedAt: 0,
              reqBytes: 0,
              failed: false,
              emitted: false,
            })
            return originalOpen.apply(this, args)
          }
      )
    )
    stops.push(
      patchMethod(
        prototype,
        'send',
        (originalSend, isActive) =>
          function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
            const [body] = args
            const state = isActive() ? states.get(this) : undefined
            if (state === undefined) {
              return originalSend.apply(this, args)
            }

            state.startedAt = options.now()
            state.reqBytes = sizeOfBody(body)

            const markFailed = () => {
              state.failed = true
            }
            const finalize = () => {
              if (state.emitted) {
                return
              }
              state.emitted = true
              this.removeEventListener('error', markFailed)
              this.removeEventListener('abort', markFailed)
              this.removeEventListener('timeout', markFailed)
              if (isActive()) {
                safeEmit(
                  emit,
                  CustomTag.Network,
                  createNetworkPayload({
                    method: state.method,
                    url: state.url,
                    status: this.status,
                    durationMs: Math.max(0, options.now() - state.startedAt),
                    failed: state.failed || this.status === 0,
                    reqBytes: state.reqBytes,
                    resBytes: xhrContentLength(this),
                  }),
                  options.onError
                )
              }
            }

            this.addEventListener('error', markFailed)
            this.addEventListener('abort', markFailed)
            this.addEventListener('timeout', markFailed)
            this.addEventListener('loadend', finalize, { once: true })

            try {
              return originalSend.apply(this, args)
            } catch (error) {
              this.removeEventListener('error', markFailed)
              this.removeEventListener('abort', markFailed)
              this.removeEventListener('timeout', markFailed)
              this.removeEventListener('loadend', finalize)
              if (isActive()) {
                safeEmit(
                  emit,
                  CustomTag.Network,
                  createNetworkPayload({
                    method: state.method,
                    url: state.url,
                    status: 0,
                    durationMs: Math.max(0, options.now() - state.startedAt),
                    failed: true,
                    reqBytes: state.reqBytes,
                  }),
                  options.onError
                )
              }
              throw error
            }
          }
      )
    )
    return combineStops(stops)
  } catch (error) {
    stopAll(stops)
    throw error
  }
}

interface XhrState {
  method: string
  url: string
  startedAt: number
  reqBytes: number | undefined
  failed: boolean
  emitted: boolean
}

function normalizeNetworkCaptureOptions(options: NetworkCaptureOptions): NetworkCaptureOptions {
  return {
    ...options,
    ignoreUrlPatterns: normalizeUrlPatterns(options.ignoreUrlPatterns),
    redactUrlPatterns: normalizeUrlPatterns(options.redactUrlPatterns),
  }
}

function normalizeUrlPatterns(patterns: RegExp[]): RegExp[] {
  return patterns.map((pattern) => {
    const flags = pattern.flags.replace(/[gy]/gu, '')
    return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags)
  })
}

function safeEmit(emit: Emit, tag: string, payload: unknown, onError: OnError | undefined): void {
  try {
    emit(tag, payload)
  } catch (error) {
    try {
      onError?.(error)
    } catch {
      // Never let capture break host application behavior.
    }
  }
}

function patchMethod(
  target: object,
  key: PropertyKey,
  createWrapper: (original: AnyFunction, isActive: () => boolean) => AnyFunction
): Stop {
  const record = target as Record<PropertyKey, unknown>
  const original = record[key]
  if (typeof original !== 'function') {
    return noop
  }
  let active = true
  const wrapper = createWrapper(original as AnyFunction, () => active)
  record[key] = wrapper
  return () => {
    if (!active) {
      return
    }
    active = false
    if (record[key] === wrapper) {
      record[key] = original
    }
  }
}

function combineStops(stops: Stop[]): Stop {
  let stopped = false
  return () => {
    if (stopped) {
      return
    }
    stopped = true
    stopAll(stops)
  }
}

function stopAll(stops: Stop[]): void {
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    try {
      stops[index]?.()
    } catch {
      // Best-effort rollback must continue through all installed patches.
    }
  }
}

function stringifyArg(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (typeof value === 'string') {
    return truncate(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Error) {
    return truncate(value.stack ?? `${value.name}: ${value.message}`)
  }
  try {
    return truncate(JSON.stringify(value))
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_ARG_LENGTH) {
    return text
  }
  return `${text.slice(0, MAX_ARG_LENGTH)}...(+${String(text.length - MAX_ARG_LENGTH)} chars)`
}

function getFetchMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  return method.toUpperCase()
}

function getFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string' || input instanceof URL) {
    return input.toString()
  }
  return input.url
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get('content-length')
  if (value === null) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function xhrContentLength(xhr: XMLHttpRequest): number | undefined {
  try {
    const value = xhr.getResponseHeader('content-length')
    if (value === null) {
      return undefined
    }
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function createNetworkPayload(options: {
  method: string
  url: string
  status: number
  durationMs: number
  failed?: boolean | undefined
  reqBytes?: number | undefined
  resBytes?: number | undefined
}): NetworkPayload {
  return {
    method: options.method,
    url: options.url,
    status: options.status,
    durationMs: options.durationMs,
    ...(options.failed === undefined ? {} : { failed: options.failed }),
    ...(options.reqBytes === undefined ? {} : { reqBytes: options.reqBytes }),
    ...(options.resBytes === undefined ? {} : { resBytes: options.resBytes }),
  }
}

function sizeOfBody(body: BodyInit | Document | null | undefined): number | undefined {
  if (body === null || body === undefined) {
    return 0
  }
  if (typeof body === 'string') {
    return body.length
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength
  }
  if (body instanceof Blob) {
    return body.size
  }
  return undefined
}

function redactUrl(url: string, patterns: RegExp[]): string {
  if (patterns.length === 0 || !patterns.some((pattern) => pattern.test(url))) {
    return url
  }
  try {
    const parsed = new URL(url, window.location.href)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    const [withoutQuery = url] = url.split('?')
    const [withoutHash = withoutQuery] = withoutQuery.split('#')
    return withoutHash
  }
}

function shouldIgnoreUrl(url: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(url))
}
