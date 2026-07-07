import type { Context } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/sdk-trace-web'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { BrowserSessionSpanProcessor } from './BrowserSessionSpanProcessor'
import { BrowserSessionManager } from './browserSession'
import { BrowserSessionReplayState } from './sessionReplay'
import type { BrowserSessionReplayRuntime } from './sessionReplay'

class TestSpan {
  readonly attributes: Record<string, unknown> = {}

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value
    return this
  }
}

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')

function createProcessor(
  options: ConstructorParameters<typeof BrowserSessionManager>[0] = {},
  replayState?: BrowserSessionReplayState
): BrowserSessionSpanProcessor {
  return new BrowserSessionSpanProcessor(
    new BrowserSessionManager({
      generateId: () => 'session-1',
      now: () => 1_000,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
      ...options,
    }),
    replayState
  )
}

function createSpan(): TestSpan {
  return new TestSpan()
}

function setLocation(location: { href: string } | undefined): void {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: location as Location | undefined,
  })
}

function startSpan(processor: BrowserSessionSpanProcessor, span: TestSpan): void {
  processor.onStart(span as unknown as Span, {} as Context)
}

function createReplayRuntime(mode: BrowserSessionReplayRuntime['mode']): BrowserSessionReplayRuntime {
  return {
    mode,
    recording: true,
    flush: async () => Promise.resolve(),
    getSessionId: () => 'session-1',
    stop: async () => Promise.resolve(),
  }
}

describe('BrowserSessionSpanProcessor', () => {
  afterEach(() => {
    if (originalLocationDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'location')
    } else {
      Object.defineProperty(globalThis, 'location', originalLocationDescriptor)
    }
  })

  it('stamps session and default URL attributes', () => {
    setLocation({ href: 'https://example.com/dashboard?tab=activity#recent' })
    const span = createSpan()

    startSpan(createProcessor(), span)

    expect(span.attributes).toEqual({
      'browser.session.id': 'session-1',
      'logfire.page.url.full': 'https://example.com/dashboard?tab=activity#recent',
      'logfire.page.url.path': '/dashboard',
      'session.id': 'session-1',
      'url.full': 'https://example.com/dashboard?tab=activity#recent',
      'url.path': '/dashboard',
    })
  })

  it('suppresses URL attributes when configured', () => {
    setLocation({ href: 'https://example.com/dashboard?tab=activity#recent' })
    const span = createSpan()

    startSpan(createProcessor({ urlAttributes: false }), span)

    expect(span.attributes).toEqual({
      'browser.session.id': 'session-1',
      'session.id': 'session-1',
    })
  })

  it('applies sanitized URL attributes from the callback', () => {
    setLocation({ href: 'https://example.com/dashboard?tab=activity#recent' })
    const span = createSpan()

    startSpan(
      createProcessor({
        urlAttributes: (url) => ({
          full: `${url.origin}${url.pathname}`,
          path: '/sanitized',
        }),
      }),
      span
    )

    expect(span.attributes).toEqual({
      'browser.session.id': 'session-1',
      'logfire.page.url.full': 'https://example.com/dashboard',
      'logfire.page.url.path': '/sanitized',
      'session.id': 'session-1',
      'url.full': 'https://example.com/dashboard',
      'url.path': '/sanitized',
    })
  })

  it('keeps explicit page URL attributes alongside compatibility URL attributes', () => {
    setLocation({ href: 'https://example.com/products/123?token=secret' })
    const span = createSpan()

    startSpan(createProcessor(), span)

    expect(span.attributes).toMatchObject({
      'logfire.page.url.full': 'https://example.com/products/123?token=secret',
      'logfire.page.url.path': '/products/123',
      'url.full': 'https://example.com/products/123?token=secret',
      'url.path': '/products/123',
    })
  })

  it('does not throw when location is unavailable', () => {
    setLocation(undefined)
    const span = createSpan()

    expect(() => {
      startSpan(createProcessor(), span)
    }).not.toThrow()
    expect(span.attributes).toEqual({
      'browser.session.id': 'session-1',
      'session.id': 'session-1',
    })
  })

  it('does not throw when URL sanitization throws', () => {
    setLocation({ href: 'https://example.com/dashboard?tab=activity#recent' })
    const span = createSpan()

    expect(() => {
      startSpan(
        createProcessor({
          urlAttributes: () => {
            throw new Error('cannot sanitize')
          },
        }),
        span
      )
    }).not.toThrow()
    expect(span.attributes).toEqual({
      'browser.session.id': 'session-1',
      'session.id': 'session-1',
    })
  })

  it('stamps active replay state attributes', () => {
    const replayState = new BrowserSessionReplayState()
    replayState.setReplay(createReplayRuntime('full'))
    const span = createSpan()

    startSpan(createProcessor({}, replayState), span)

    expect(span.attributes).toMatchObject({
      'logfire.session_replay.active': true,
      'logfire.session_replay.mode': 'full',
    })
  })

  it('reads live replay mode on each span start', () => {
    let mode: BrowserSessionReplayRuntime['mode'] = 'buffer'
    const replayState = new BrowserSessionReplayState()
    replayState.setReplay({
      get mode() {
        return mode
      },
      recording: true,
      flush: async () => Promise.resolve(),
      getSessionId: () => 'session-1',
      stop: async () => Promise.resolve(),
    })
    const processor = createProcessor({}, replayState)
    const firstSpan = createSpan()
    const secondSpan = createSpan()

    startSpan(processor, firstSpan)
    mode = 'full'
    startSpan(processor, secondSpan)

    expect(firstSpan.attributes['logfire.session_replay.mode']).toBe('buffer')
    expect(secondSpan.attributes['logfire.session_replay.mode']).toBe('full')
  })

  it('does not stamp replay state when replay is absent, stopped, or off', () => {
    const replayState = new BrowserSessionReplayState()
    const beforeReplay = createSpan()
    startSpan(createProcessor({}, replayState), beforeReplay)
    expect(beforeReplay.attributes).not.toHaveProperty('logfire.session_replay.active')

    replayState.setReplay(createReplayRuntime('off'))
    const sampledOff = createSpan()
    startSpan(createProcessor({}, replayState), sampledOff)
    expect(sampledOff.attributes).not.toHaveProperty('logfire.session_replay.active')

    replayState.setReplay(createReplayRuntime('full'))
    replayState.clear()
    const afterStop = createSpan()
    startSpan(createProcessor({}, replayState), afterStop)
    expect(afterStop.attributes).not.toHaveProperty('logfire.session_replay.active')
  })
})
