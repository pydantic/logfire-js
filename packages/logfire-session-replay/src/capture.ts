import { CustomTag } from './types'
import type { ConsoleLevel, ConsolePayload, NavigationPayload, NetworkPayload } from './types'

type Emit = (tag: string, payload: unknown) => void
type Stop = () => void

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug']
const MAX_ARG_LENGTH = 1024
const MAX_ARGS = 10
const noop: Stop = () => undefined

export function captureConsole(emit: Emit): Stop {
  const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>()
  let stopped = false

  for (const level of CONSOLE_LEVELS) {
    const original = (console as Record<ConsoleLevel, unknown>)[level]
    if (typeof original !== 'function') {
      continue
    }
    const originalConsoleMethod = original as (...args: unknown[]) => void
    originals.set(level, originalConsoleMethod)
    ;(console as Record<ConsoleLevel, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      try {
        emit(CustomTag.Console, {
          level,
          args: args.slice(0, MAX_ARGS).map(stringifyArg),
        } satisfies ConsolePayload)
      } catch {
        // Never let capture break host logging.
      }
      originalConsoleMethod.apply(console, args)
    }
  }

  return () => {
    if (stopped) {
      return
    }
    stopped = true
    for (const [level, original] of originals) {
      ;(console as Record<ConsoleLevel, (...args: unknown[]) => void>)[level] = original
    }
  }
}

export function captureNetwork(emit: Emit, options: { redactUrlPatterns: RegExp[]; now: () => number }): Stop {
  const stopFetch = captureFetch(emit, options)
  const stopXhr = captureXhr(emit, options)
  let stopped = false
  return () => {
    if (stopped) {
      return
    }
    stopped = true
    stopFetch()
    stopXhr()
  }
}

export function captureNavigation(emit: Emit): Stop {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- keep exact original so stop() restores identity.
  const originalPush = history.pushState
  // eslint-disable-next-line @typescript-eslint/unbound-method -- keep exact original so stop() restores identity.
  const originalReplace = history.replaceState
  let stopped = false
  const emitNavigation = (kind: NavigationPayload['kind']) => {
    emit(CustomTag.Navigation, { url: window.location.href, kind } satisfies NavigationPayload)
  }

  history.pushState = function (...args) {
    originalPush.apply(this, args)
    emitNavigation('push')
  }
  history.replaceState = function (...args) {
    originalReplace.apply(this, args)
    emitNavigation('replace')
  }
  const onPop = () => {
    emitNavigation('pop')
  }
  window.addEventListener('popstate', onPop)

  return () => {
    if (stopped) {
      return
    }
    stopped = true
    history.pushState = originalPush
    history.replaceState = originalReplace
    window.removeEventListener('popstate', onPop)
  }
}

function captureFetch(emit: Emit, options: { redactUrlPatterns: RegExp[]; now: () => number }): Stop {
  const original = window.fetch
  if (typeof original !== 'function') {
    return noop
  }
  let stopped = false

  const wrapped: typeof window.fetch = async (input, init) => {
    const startedAt = options.now()
    const method = getFetchMethod(input, init)
    const url = redactUrl(getFetchUrl(input), options.redactUrlPatterns)
    const reqBytes = sizeOfBody(init?.body)

    try {
      const response = await original(input, init)
      emit(
        CustomTag.Network,
        createNetworkPayload({
          method,
          url,
          status: response.status,
          durationMs: Math.max(0, options.now() - startedAt),
          reqBytes,
          resBytes: contentLength(response.headers),
        })
      )
      return response
    } catch (error) {
      emit(
        CustomTag.Network,
        createNetworkPayload({
          method,
          url,
          status: 0,
          durationMs: Math.max(0, options.now() - startedAt),
          failed: true,
          reqBytes,
        })
      )
      throw error
    }
  }

  window.fetch = wrapped

  return () => {
    if (stopped) {
      return
    }
    stopped = true
    window.fetch = original
  }
}

function captureXhr(emit: Emit, options: { redactUrlPatterns: RegExp[]; now: () => number }): Stop {
  const prototype = window.XMLHttpRequest.prototype
  // eslint-disable-next-line @typescript-eslint/unbound-method -- keep exact original so stop() restores identity.
  const originalOpen = prototype.open
  // eslint-disable-next-line @typescript-eslint/unbound-method -- keep exact original so stop() restores identity.
  const originalSend = prototype.send
  const states = new WeakMap<XMLHttpRequest, XhrState>()
  let stopped = false

  prototype.open = function (method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void {
    states.set(this, {
      method: method.toUpperCase(),
      url: redactUrl(url.toString(), options.redactUrlPatterns),
      startedAt: 0,
      reqBytes: 0,
      failed: false,
      emitted: false,
    })
    originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  }

  prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const state = states.get(this)
    if (state === undefined) {
      originalSend.call(this, body)
      return
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
      emit(
        CustomTag.Network,
        createNetworkPayload({
          method: state.method,
          url: state.url,
          status: this.status,
          durationMs: Math.max(0, options.now() - state.startedAt),
          failed: state.failed || this.status === 0,
          reqBytes: state.reqBytes,
          resBytes: xhrContentLength(this),
        })
      )
    }

    this.addEventListener('error', markFailed)
    this.addEventListener('abort', markFailed)
    this.addEventListener('timeout', markFailed)
    this.addEventListener('loadend', finalize, { once: true })

    try {
      originalSend.call(this, body)
    } catch (error) {
      this.removeEventListener('error', markFailed)
      this.removeEventListener('abort', markFailed)
      this.removeEventListener('timeout', markFailed)
      this.removeEventListener('loadend', finalize)
      emit(
        CustomTag.Network,
        createNetworkPayload({
          method: state.method,
          url: state.url,
          status: 0,
          durationMs: Math.max(0, options.now() - state.startedAt),
          failed: true,
          reqBytes: state.reqBytes,
        })
      )
      throw error
    }
  }

  return () => {
    if (stopped) {
      return
    }
    stopped = true
    prototype.open = originalOpen
    prototype.send = originalSend
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
