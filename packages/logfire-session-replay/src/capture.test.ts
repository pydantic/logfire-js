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

    console.warn('something happened', 42, { nested: 'value' })

    expect(originalSpy).toHaveBeenCalledWith('something happened', 42, { nested: 'value' })
    expect(emit).toHaveBeenCalledTimes(1)
    const [tag, payload] = emit.mock.calls[0]!
    expect(tag).toBe(CustomTag.Console)
    expect(payload).toMatchObject({
      level: 'warn',
      args: ['something happened', '42', '{"nested":"value"}'],
    } satisfies ConsolePayload)

    stop()
    console.warn = originalWarn
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
