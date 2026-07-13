/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, @typescript-eslint/strict-void-return, @typescript-eslint/unbound-method, no-empty-function, vitest/require-mock-type-parameters */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { captureConsole, captureNavigation, captureNetwork } from './capture'
import { CustomTag } from './types'
import type { ConsolePayload, NavigationPayload, NetworkPayload } from './types'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('captureConsole', () => {
  it('emits bounded console payloads and calls through to the original console', () => {
    const originalWarn = console.warn
    const originalSpy = vi.fn()
    console.warn = originalSpy
    const emit = vi.fn()
    const stop = captureConsole(emit)
    try {
      console.warn('something happened', 42, { nested: 'value' })

      expect(originalSpy).toHaveBeenCalledWith('something happened', 42, { nested: 'value' })
      expect(emit).toHaveBeenCalledTimes(1)
      const [tag, payload] = emit.mock.calls[0]!
      expect(tag).toBe(CustomTag.Console)
      expect(payload).toMatchObject({
        level: 'warn',
        args: ['something happened', '42', '{"nested":"value"}'],
      } satisfies ConsolePayload)
    } finally {
      stop()
      console.warn = originalWarn
    }
  })

  it('truncates long strings and caps argument count', () => {
    const originalLog = console.log
    const passthroughLog = vi.fn()
    console.log = passthroughLog
    const emit = vi.fn()
    const stop = captureConsole(emit)
    try {
      console.log(...Array.from({ length: 15 }, (_value, index) => (index === 0 ? 'x'.repeat(5_000) : index)))
      const payload = emit.mock.calls[0]![1] as ConsolePayload
      expect(payload.args).toHaveLength(10)
      expect(payload.args[0]!.length).toBeLessThan(2_000)
      expect(payload.args[0]).toMatch(/\(\+\d+ chars\)$/u)
      expect(passthroughLog).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      console.log = originalLog
    }
  })

  it('restores console methods idempotently', () => {
    const realLog = console.log
    const originalLog = vi.fn()
    console.log = originalLog
    const emit = vi.fn()
    const stop = captureConsole(emit)
    try {
      stop()
      stop()
      expect(console.log).toBe(originalLog)
      console.log('after stop')
      expect(originalLog).toHaveBeenCalledWith('after stop')
      expect(emit).not.toHaveBeenCalled()
    } finally {
      console.log = realLog
    }
  })

  it('keeps a later console wrapper installed and makes the stopped Logfire wrapper inert', () => {
    const realLog = console.log
    const originalLog = vi.fn()
    console.log = originalLog
    const emit = vi.fn()
    const stop = captureConsole(emit)
    const logfireWrapper = console.log
    const thirdParty = vi.fn(function (this: Console, ...args: unknown[]) {
      logfireWrapper.apply(this, args)
    })
    console.log = thirdParty
    try {
      stop()
      expect(console.log).toBe(thirdParty)
      console.log('after stop')
      expect(thirdParty).toHaveBeenCalledWith('after stop')
      expect(originalLog).toHaveBeenCalledWith('after stop')
      expect(emit).not.toHaveBeenCalled()
    } finally {
      console.log = realLog
    }
  })

  it('rolls back earlier console patches when a later method cannot be assigned', () => {
    const originalLog = console.log
    const warnDescriptor = Object.getOwnPropertyDescriptor(console, 'warn')
    Object.defineProperty(console, 'warn', { configurable: true, value: console.warn, writable: false })
    try {
      expect(() => captureConsole(vi.fn())).toThrow(/read only/u)
      expect(console.log).toBe(originalLog)
    } finally {
      if (warnDescriptor !== undefined) {
        Object.defineProperty(console, 'warn', warnDescriptor)
      }
    }
  })

  it('guards reporter reentrancy when onError logs through captured console', () => {
    const originalError = console.error
    const passthroughError = vi.fn()
    console.error = passthroughError
    const emit = vi.fn(() => {
      throw new Error('emit failed')
    })
    let reportCalls = 0
    const stop = captureConsole(emit, {
      onError: () => {
        reportCalls += 1
        console.error('reporting capture failure')
      },
    })
    try {
      expect(() => {
        console.warn('trigger')
      }).not.toThrow()
      expect(reportCalls).toBe(1)
      expect(passthroughError).toHaveBeenCalledWith('reporting capture failure')
    } finally {
      stop()
      console.error = originalError
    }
  })
})

describe('captureNetwork', () => {
  it('captures fetch success and restores window.fetch', async () => {
    const originalFetch = vi.fn(async () => new Response('ok', { status: 201, headers: { 'content-length': '2' } }))
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const emit = vi.fn()
    let now = 1_000
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => now })

    const promise = window.fetch('/api/things', { method: 'POST', body: '{"a":1}' })
    now = 1_125
    await promise

    expect(emit).toHaveBeenCalledWith(
      CustomTag.Network,
      expect.objectContaining({
        method: 'POST',
        url: '/api/things',
        status: 201,
        durationMs: 125,
        reqBytes: 7,
        resBytes: 2,
      } satisfies Partial<NetworkPayload>)
    )
    stop()
    expect(window.fetch).toBe(originalFetch)
  })

  it('counts fetch string bodies as UTF-8 bytes', async () => {
    const originalFetch = vi.fn(async () => new Response(null, { status: 204 }))
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })

    await window.fetch('/api/utf8', { method: 'POST', body: 'é🚀' })

    expect(emit).toHaveBeenCalledWith(CustomTag.Network, expect.objectContaining({ reqBytes: 6 } satisfies Partial<NetworkPayload>))
    stop()
  })

  it('does not inspect a body carried only by a Request input', async () => {
    const originalFetch = vi.fn(async () => new Response(null, { status: 204 }))
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })

    await window.fetch(new Request('https://api.example.com/request-body', { method: 'POST', body: 'é🚀' }))

    expect(emit).toHaveBeenCalledWith(CustomTag.Network, expect.objectContaining({ reqBytes: 0 } satisfies Partial<NetworkPayload>))
    stop()
  })

  it('exposes flattened OpenTelemetry __original metadata on the replay fetch wrapper', async () => {
    const underlyingFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const otelFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => underlyingFetch(input, init)) as unknown as typeof fetch
    Object.defineProperty(otelFetch, '__original', {
      configurable: true,
      value: underlyingFetch,
      writable: true,
    })
    Object.defineProperty(window, 'fetch', { value: otelFetch, writable: true, configurable: true })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [/\/client-traces/u], redactUrlPatterns: [], now: () => 0 })

    const descriptor = Object.getOwnPropertyDescriptor(window.fetch, '__original')
    expect(descriptor).toEqual({ configurable: true, enumerable: false, value: underlyingFetch, writable: true })
    const exporterFetch = Reflect.get(window.fetch, '__original') as typeof fetch
    await exporterFetch('/client-traces')

    expect(underlyingFetch).toHaveBeenCalledTimes(1)
    expect(otelFetch).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    stop()
    expect(window.fetch).toBe(otelFetch)
  })

  it('points __original at a raw predecessor when no wrapper metadata exists', () => {
    const originalFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const stop = captureNetwork(vi.fn(), { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })

    expect(Reflect.get(window.fetch, '__original')).toBe(originalFetch)
    stop()
  })

  it('keeps a later fetch wrapper installed and suppresses stopped Logfire emission', async () => {
    const originalFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })
    const logfireWrapper = window.fetch
    const thirdParty = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => logfireWrapper(input, init)) as unknown as typeof fetch
    window.fetch = thirdParty

    stop()
    expect(window.fetch).toBe(thirdParty)
    await window.fetch('/after-stop')
    expect(originalFetch).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
  })

  it('captures fetch failures and rethrows host errors', async () => {
    Object.defineProperty(window, 'fetch', {
      value: async () => {
        throw new TypeError('network down')
      },
      writable: true,
      configurable: true,
    })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })

    await expect(window.fetch('/api/fail')).rejects.toThrow('network down')
    expect(emit).toHaveBeenCalledWith(
      CustomTag.Network,
      expect.objectContaining({ status: 0, failed: true } satisfies Partial<NetworkPayload>)
    )
    stop()
  })

  it('does not reject successful fetches when emit throws', async () => {
    Object.defineProperty(window, 'fetch', {
      value: async () => new Response('ok', { status: 200 }),
      writable: true,
      configurable: true,
    })
    const emitError = new Error('emit failed')
    const emit = vi.fn(() => {
      throw emitError
    })
    const onError = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0, onError })

    await expect(window.fetch('/api/ok')).resolves.toBeInstanceOf(Response)
    expect(onError).toHaveBeenCalledWith(emitError)
    stop()
  })

  it('preserves the original fetch failure when failure emit throws', async () => {
    const hostError = new TypeError('network down')
    Object.defineProperty(window, 'fetch', {
      value: async () => {
        throw hostError
      },
      writable: true,
      configurable: true,
    })
    const emitError = new Error('emit failed')
    const emit = vi.fn(() => {
      throw emitError
    })
    const onError = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0, onError })

    await expect(window.fetch('/api/fail')).rejects.toBe(hostError)
    expect(onError).toHaveBeenCalledWith(emitError)
    stop()
  })

  it('redacts matching fetch URLs without recording bodies', async () => {
    Object.defineProperty(window, 'fetch', {
      value: async () => new Response('', { status: 200 }),
      writable: true,
      configurable: true,
    })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [/\/secrets/u], now: () => 0 })
    await window.fetch('https://api.example.com/secrets/abc?token=xyz#section')
    const payload = emit.mock.calls[0]![1] as NetworkPayload
    expect(payload.url).toBe('https://api.example.com/secrets/abc')
    expect(payload).not.toHaveProperty('body')
    stop()
  })

  it('normalizes stateful redact URL patterns for repeated fetch decisions', async () => {
    Object.defineProperty(window, 'fetch', {
      value: async () => new Response('', { status: 200 }),
      writable: true,
      configurable: true,
    })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [/token=/gu], now: () => 0 })

    await window.fetch('https://api.example.com/items?token=one')
    await window.fetch('https://api.example.com/items?token=two')

    expect(emit.mock.calls.map((call) => (call[1] as NetworkPayload).url)).toEqual([
      'https://api.example.com/items',
      'https://api.example.com/items',
    ])
    stop()
  })

  it('captures XHR success and restores XMLHttpRequest hooks', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const emit = vi.fn()
    let now = 10
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [/\/secrets/u], now: () => now })
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr

    xhr.open('post', 'https://api.example.com/secrets/abc?token=xyz')
    xhr.send('payload')
    now = 42
    xhr.complete(202, { 'content-length': '8' })

    expect(emit).toHaveBeenCalledWith(
      CustomTag.Network,
      expect.objectContaining({
        method: 'POST',
        url: 'https://api.example.com/secrets/abc',
        status: 202,
        durationMs: 32,
        reqBytes: 7,
        resBytes: 8,
        failed: false,
      } satisfies Partial<NetworkPayload>)
    )

    const wrappedOpen = window.XMLHttpRequest.prototype.open
    stop()
    stop()
    expect(window.XMLHttpRequest.prototype.open).not.toBe(wrappedOpen)
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })

  it('counts XHR string bodies as UTF-8 bytes', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr

    xhr.open('POST', '/api/utf8')
    xhr.send('é🚀')
    xhr.complete(204)

    expect(emit).toHaveBeenCalledWith(CustomTag.Network, expect.objectContaining({ reqBytes: 6 } satisfies Partial<NetworkPayload>))
    stop()
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })

  it('keeps later XHR wrappers installed and makes stopped Logfire wrappers inert', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const prototype = window.XMLHttpRequest.prototype
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })
    const logfireOpen = prototype.open
    const logfireSend = prototype.send
    const thirdPartyOpen = vi.fn(function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
      logfireOpen.apply(this, args)
    }) as unknown as typeof prototype.open
    const thirdPartySend = vi.fn(function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
      logfireSend.apply(this, args)
    }) as typeof prototype.send
    prototype.open = thirdPartyOpen
    prototype.send = thirdPartySend

    stop()
    expect(prototype.open).toBe(thirdPartyOpen)
    expect(prototype.send).toBe(thirdPartySend)
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr
    xhr.open('GET', '/after-stop')
    xhr.send()
    xhr.complete(200)
    expect(emit).not.toHaveBeenCalled()
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })

  it('preserves XHR receivers, arguments, and predecessor return values', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const prototype = window.XMLHttpRequest.prototype
    const openResult = Symbol('open result')
    const sendResult = Symbol('send result')
    const originalOpen = vi.fn(function () {
      return openResult
    })
    const originalSend = vi.fn(function () {
      return sendResult
    })
    prototype.open = originalOpen as unknown as typeof prototype.open
    prototype.send = originalSend as unknown as typeof prototype.send
    const stop = captureNetwork(vi.fn(), { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })
    const xhr = new window.XMLHttpRequest()
    const wrappedOpen = xhr.open as unknown as (method: string, url: string) => unknown
    const wrappedSend = xhr.send as unknown as () => unknown

    expect(wrappedOpen.call(xhr, 'GET', '/exact-arguments')).toBe(openResult)
    expect(wrappedSend.call(xhr)).toBe(sendResult)
    expect(originalOpen.mock.contexts).toEqual([xhr])
    expect(originalOpen.mock.calls).toEqual([['GET', '/exact-arguments']])
    expect(originalSend.mock.contexts).toEqual([xhr])
    expect(originalSend.mock.calls).toEqual([[]])

    stop()
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })

  it('captures XHR failures without request or response bodies', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0 })
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr

    xhr.open('GET', '/api/fail')
    xhr.send()
    xhr.fail()

    const payload = emit.mock.calls[0]![1] as NetworkPayload
    expect(payload).toMatchObject({ method: 'GET', url: '/api/fail', status: 0, failed: true })
    expect(payload).not.toHaveProperty('body')
    stop()
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })

  it('does not throw from XHR completion when emit throws', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const emitError = new Error('emit failed')
    const emit = vi.fn(() => {
      throw emitError
    })
    const onError = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [], redactUrlPatterns: [], now: () => 0, onError })
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr

    xhr.open('GET', '/api/ok')
    xhr.send()
    expect(() => {
      xhr.complete(200)
    }).not.toThrow()
    expect(onError).toHaveBeenCalledWith(emitError)
    stop()
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })

  it('suppresses ignored fetch URLs entirely', async () => {
    const originalFetch = vi.fn(async () => new Response(null, { status: 204 }))
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [/\/client-traces/u], redactUrlPatterns: [], now: () => 0 })

    await window.fetch('https://api.example.com/client-traces?token=secret')

    expect(originalFetch).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
    stop()
  })

  it('normalizes stateful ignore URL patterns for repeated fetch decisions', async () => {
    const originalFetch = vi.fn(async () => new Response(null, { status: 204 }))
    Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true })
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [/\/client-traces/gu], redactUrlPatterns: [], now: () => 0 })

    await window.fetch('https://api.example.com/client-traces?token=one')
    await window.fetch('https://api.example.com/client-traces?token=two')

    expect(originalFetch).toHaveBeenCalledTimes(2)
    expect(emit).not.toHaveBeenCalled()
    stop()
  })

  it('suppresses ignored XHR URLs entirely', () => {
    const OriginalXhr = window.XMLHttpRequest
    installFakeXhr()
    const emit = vi.fn()
    const stop = captureNetwork(emit, { ignoreUrlPatterns: [/\/client-metrics/u], redactUrlPatterns: [], now: () => 0 })
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr

    xhr.open('POST', 'https://api.example.com/client-metrics?token=secret')
    xhr.send('payload')
    xhr.complete(202)

    expect(emit).not.toHaveBeenCalled()
    stop()
    Object.defineProperty(window, 'XMLHttpRequest', { value: OriginalXhr, writable: true, configurable: true })
  })
})

describe('captureNavigation', () => {
  it('captures SPA navigation and restores history hooks', () => {
    const originalPush = history.pushState
    const emit = vi.fn()
    const stop = captureNavigation(emit)
    history.pushState({}, '', '/pushed')
    history.replaceState({}, '', '/replaced')
    window.dispatchEvent(new PopStateEvent('popstate'))
    stop()
    stop()

    expect(emit.mock.calls.map(([_tag, payload]) => (payload as NavigationPayload).kind)).toEqual(['push', 'replace', 'pop'])
    expect(history.pushState).toBe(originalPush)
  })

  it('does not throw from navigation capture when emit throws', () => {
    const emitError = new Error('emit failed')
    const onError = vi.fn()
    const stop = captureNavigation(
      () => {
        throw emitError
      },
      { onError }
    )

    expect(() => {
      history.pushState({}, '', '/safe-navigation')
    }).not.toThrow()
    expect(onError).toHaveBeenCalledWith(emitError)
    stop()
  })

  it('keeps later history wrappers installed and makes stopped Logfire wrappers inert', () => {
    const originalPush = history.pushState
    const originalReplace = history.replaceState
    const emit = vi.fn()
    const stop = captureNavigation(emit)
    const logfirePush = history.pushState
    const logfireReplace = history.replaceState
    const thirdPartyPush = vi.fn(function (this: History, ...args: Parameters<History['pushState']>) {
      logfirePush.apply(this, args)
    })
    const thirdPartyReplace = vi.fn(function (this: History, ...args: Parameters<History['replaceState']>) {
      logfireReplace.apply(this, args)
    })
    history.pushState = thirdPartyPush
    history.replaceState = thirdPartyReplace
    try {
      stop()
      expect(history.pushState).toBe(thirdPartyPush)
      expect(history.replaceState).toBe(thirdPartyReplace)
      history.pushState({}, '', '/third-party-push')
      history.replaceState({}, '', '/third-party-replace')
      expect(emit).not.toHaveBeenCalled()
    } finally {
      history.pushState = originalPush
      history.replaceState = originalReplace
    }
  })

  it('preserves history receivers, arguments, and predecessor return values', () => {
    const originalPush = history.pushState
    const originalReplace = history.replaceState
    const pushResult = Symbol('push result')
    const replaceResult = Symbol('replace result')
    const predecessorPush = vi.fn(function () {
      return pushResult
    })
    const predecessorReplace = vi.fn(function () {
      return replaceResult
    })
    history.pushState = predecessorPush as unknown as typeof history.pushState
    history.replaceState = predecessorReplace as unknown as typeof history.replaceState
    try {
      const stop = captureNavigation(vi.fn())
      const wrappedPush = history.pushState as unknown as (data: unknown, unused: string, url: string) => unknown
      const wrappedReplace = history.replaceState as unknown as (data: unknown, unused: string, url: string) => unknown
      expect(wrappedPush.call(history, { page: 1 }, '', '/push')).toBe(pushResult)
      expect(wrappedReplace.call(history, { page: 2 }, '', '/replace')).toBe(replaceResult)
      expect(predecessorPush.mock.contexts).toEqual([history])
      expect(predecessorPush.mock.calls).toEqual([[{ page: 1 }, '', '/push']])
      expect(predecessorReplace.mock.contexts).toEqual([history])
      expect(predecessorReplace.mock.calls).toEqual([[{ page: 2 }, '', '/replace']])
      stop()
    } finally {
      history.pushState = originalPush
      history.replaceState = originalReplace
    }
  })
})

class FakeXhr extends EventTarget {
  status = 0
  private responseHeaders = new Map<string, string>()

  open(_method: string, _url: string | URL): void {}

  send(_body?: Document | XMLHttpRequestBodyInit | null): void {}

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null
  }

  complete(status: number, headers: Record<string, string> = {}): void {
    this.status = status
    this.responseHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    this.dispatchEvent(new ProgressEvent('loadend'))
  }

  fail(): void {
    this.status = 0
    this.dispatchEvent(new ProgressEvent('error'))
    this.dispatchEvent(new ProgressEvent('loadend'))
  }
}

function installFakeXhr(): void {
  Object.defineProperty(window, 'XMLHttpRequest', {
    value: FakeXhr as unknown as typeof XMLHttpRequest,
    writable: true,
    configurable: true,
  })
}
