/** @vitest-environment jsdom */
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { BrowserSessionManager } from './browserSession'
import { BrowserSessionSpanProcessor } from './BrowserSessionSpanProcessor'
import { BrowserSessionReplayState } from './sessionReplay'
import { startBrowserFrustration } from './browserFrustration'

let stop: (() => void) | undefined
let provider: WebTracerProvider | undefined
let session: BrowserSessionManager | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(async () => {
  stop?.()
  stop = undefined
  session?.flushPendingStorage()
  await provider?.shutdown()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function start(onSignal?: () => void) {
  session = new BrowserSessionManager({ storage: null })
  const exporter = new InMemorySpanExporter()
  const callback: SpanProcessor = {
    onStart(span) {
      if (span.name.startsWith('browser.')) {
        onSignal?.()
      }
    },
    onEnd: () => undefined,
    forceFlush: async () => Promise.resolve(),
    shutdown: async () => Promise.resolve(),
  }
  provider = new WebTracerProvider({
    spanProcessors: [new BrowserSessionSpanProcessor(session), callback, new SimpleSpanProcessor(exporter)],
  })
  const listeners = vi.spyOn(document, 'addEventListener')
  const observe = vi.spyOn(MutationObserver.prototype, 'observe')
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
  const replayState = new BrowserSessionReplayState()
  stop = startBrowserFrustration({
    sessionManager: session,
    replayState,
    tracer: provider.getTracer('test'),
    deadClicks: true,
  })
  const listener = listeners.mock.calls.filter(([type]) => type === 'click').at(-1)?.[1]
  if (typeof listener !== 'function') {
    throw new Error('Missing delegated click listener')
  }
  const button = document.createElement('button')
  document.body.append(button)
  const click = (path: EventTarget[] = [button, document.body, document, window]) => {
    // Only the browser's trusted-input boundary is doubled here. Playwright covers native trust and paths.
    const event = new Proxy(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }), {
      get(target, key) {
        if (key === 'isTrusted') {
          return true
        }
        if (key === 'composedPath') {
          return () => path
        }
        return Reflect.get(target, key, target) as unknown
      },
    })
    listener.call(document, event)
  }
  return { click, exporter, observe, disconnect, replayState }
}

describe('frustration observation lifecycle', () => {
  it('does not let synthetic gestures cancel a real pending observation', async () => {
    const { click, exporter } = start()
    click()
    await vi.advanceTimersByTimeAsync(3000)
    for (const name of ['pointerdown', 'keydown', 'wheel']) {
      document.dispatchEvent(new Event(name, { bubbles: true }))
    }
    await vi.advanceTimersByTimeAsync(4000)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.dead_click'])
  })

  it('returns to its timer baseline through 100 start, click, mutation, and shutdown cycles', async () => {
    const baseline = vi.getTimerCount()
    for (let cycle = 0; cycle < 100; cycle++) {
      const { click, exporter } = start()
      click()
      click()
      click()
      expect(exporter.getFinishedSpans()).toHaveLength(1)
      document.body.append(document.createElement('div'))
      // eslint-disable-next-line no-await-in-loop -- deliver each cycle's observer before teardown.
      await vi.advanceTimersByTimeAsync(1)
      stop?.()
      session?.flushPendingStorage()
      click() // An already captured callback cannot report after shutdown.
      // eslint-disable-next-line no-await-in-loop -- expose any leaked deadline in this cycle.
      await vi.advanceTimersByTimeAsync(10000)
      expect(exporter.getFinishedSpans()).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(baseline)
      // eslint-disable-next-line no-await-in-loop -- shutdown clears the in-memory exporter, after the assertions above.
      await provider?.shutdown()
      document.body.replaceChildren()
    }
  })
  it('does not reopen observation when teardown fails inside a new click callback', () => {
    const { click, observe } = start()
    click()
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 11000)
    vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementationOnce(() => {
      throw new Error('disconnect wrapper failed')
    })
    click()
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('disables further observation after an observer teardown failure', async () => {
    const { click, exporter, observe } = start()
    click()
    vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementationOnce(() => {
      throw new Error('disconnect wrapper failed')
    })
    document.body.append(document.createElement('div'))
    await vi.advanceTimersByTimeAsync(1)
    const observedBeforeFailure = observe.mock.calls.length
    click()
    click()
    click()
    await vi.advanceTimersByTimeAsync(8000)
    expect(exporter.getFinishedSpans()).toEqual([])
    expect(observe).toHaveBeenCalledTimes(observedBeforeFailure)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores hidden-page clicks and starts a fresh episode when the page becomes visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { click, exporter, observe } = start()
    click()
    expect(observe).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    click()
    click()
    click()
    await vi.advanceTimersByTimeAsync(8000)
    expect(exporter.getFinishedSpans()).toEqual([])
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    click()
    click()
    click()
    stop?.()
    await vi.advanceTimersByTimeAsync(8000)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.rage_click'])
  })

  it.each(['listener', 'observer'] as const)('finishes cleanup even when a third-party %s wrapper throws', async (failure) => {
    const { click, exporter } = start()
    click()
    const windowRemoves = vi.spyOn(window, 'removeEventListener')
    const removeListener = document.removeEventListener.bind(document)
    const remove = vi.spyOn(document, 'removeEventListener').mockImplementation((name, listener, options) => {
      if (failure === 'listener' && name === 'click') {
        throw new Error('remove wrapper failed')
      }
      removeListener(name, listener, options)
    })
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    if (failure === 'observer') {
      disconnect.mockImplementationOnce(() => {
        throw new Error('disconnect wrapper failed')
      })
    }
    try {
      expect(() => stop?.()).not.toThrow()
      expect(windowRemoves).toHaveBeenCalledWith('pagehide', expect.any(Function))
      click()
      click()
      click()
      await vi.advanceTimersByTimeAsync(8000)
      expect(exporter.getFinishedSpans()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      remove.mockRestore()
      disconnect.mockRestore()
      stop?.()
    }
  })

  it('does not resurrect pending clicks when a span processor navigates away and back during emission', async () => {
    const { click, exporter } = start(() => {
      const original = location.href
      history.pushState({}, '', '/during-reporting')
      history.replaceState({}, '', original)
    })
    click()
    click()
    click()
    await vi.advanceTimersByTimeAsync(8000)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.rage_click'])
  })

  it('leaves no detector timer if a span processor stops the detector during emission', async () => {
    const { click, exporter } = start(() => {
      stop?.()
    })
    click()
    click()
    click()
    // Session persistence belongs to the SDK, not this detector's stop callback.
    session?.flushPendingStorage()
    await vi.advanceTimersByTimeAsync(1)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.rage_click'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains a failing span processor and can report a subsequent episode', async () => {
    let fail = true
    const { click, exporter } = start(() => {
      if (fail) {
        throw new Error('customer processor failed')
      }
    })
    expect(() => {
      click()
      click()
      click()
    }).not.toThrow()
    fail = false
    await vi.advanceTimersByTimeAsync(1000)
    click()
    click()
    click()
    await vi.advanceTimersByTimeAsync(1)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.rage_click'])
  })

  it('does no observing or timer polling while idle, and releases observation after classification', async () => {
    const { click, exporter, observe, disconnect } = start()
    expect(observe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    click()
    expect(observe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(7000)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.dead_click'])
    expect(disconnect).toHaveBeenCalled()
    // The real in-memory exporter acknowledges on its own zero-delay timeout.
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a severely delayed deadline instead of manufacturing a dead click', async () => {
    const { click, exporter } = start()
    click()
    // Advance monotonic time without allowing callbacks to establish an observation window.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 11000)
    await vi.advanceTimersByTimeAsync(7000)
    expect(exporter.getFinishedSpans()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  for (const callback of ['response', 'click'] as const) {
    it(`discards a stalled observation when a ${callback} callback runs before the overdue timer`, async () => {
      const { click, exporter } = start()
      click()
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 11000)
      if (callback === 'click') {
        click()
      } else {
        document.body.append(document.createElement('div'))
      }
      await vi.advanceTimersByTimeAsync(1)
      expect(exporter.getFinishedSpans()).toEqual([])
    })
  }

  it.each(['visibilitychange', 'pagehide', 'blur', 'popstate', 'hashchange'] as const)(
    'discards pending observations and rage history at %s',
    async (name) => {
      const { click, exporter } = start()
      const target = name === 'visibilitychange' ? document : window
      click()
      click()
      target.dispatchEvent(new Event(name))
      click()
      expect(exporter.getFinishedSpans()).toEqual([])
      target.dispatchEvent(new Event(name))
      await vi.advanceTimersByTimeAsync(8000)
      expect(exporter.getFinishedSpans()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('disconnects and resets immediately on session rotation', async () => {
    const { click, exporter, disconnect } = start()
    click()
    session?.reset()
    expect(disconnect).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(8000)
    expect(exporter.getFinishedSpans()).toEqual([])
  })

  it('stops emitting at the per-session cap and resumes only for a new session', async () => {
    const { click, exporter, observe } = start()
    for (let episode = 0; episode < 51; episode++) {
      click()
      click()
      click()
      // Each episode must finish before the next one can exercise the session-wide cap.
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(exporter.getFinishedSpans()).toHaveLength(50)
    const observations = observe.mock.calls.length
    click()
    expect(observe).toHaveBeenCalledTimes(observations)
    session?.reset()
    click()
    click()
    click()
    expect(exporter.getFinishedSpans()).toHaveLength(51)
  })

  it('cleanup makes an already captured event callback inert', async () => {
    const { click, exporter, observe } = start()
    stop?.()
    click()
    click()
    click()
    await vi.advanceTimersByTimeAsync(8000)
    expect(exporter.getFinishedSpans()).toEqual([])
    expect(observe).not.toHaveBeenCalled()
  })

  it('keeps the original replay identity after the recorder changes during response detection', async () => {
    const { click, exporter, replayState } = start()
    replayState.setReplay({
      mode: 'full',
      recording: true,
      getRecordingId: () => 'original-recording',
      captureError: () => undefined,
      flush: async () => Promise.resolve(),
      stop: async () => Promise.resolve(),
    })
    click()
    replayState.clear()
    await vi.advanceTimersByTimeAsync(3000)
    document.body.append(document.createElement('div'))
    await vi.advanceTimersByTimeAsync(1)
    const spans = exporter.getFinishedSpans()
    expect(spans.map((span) => span.name)).toEqual(['browser.slow_click'])
    expect(spans[0]?.attributes['logfire.session_replay.id']).toBe('original-recording')
  })

  it('bounds observed roots and removes old shadow listeners when starting a new observation window', async () => {
    const { click, exporter } = start()
    const paths = Array.from({ length: 64 }, () => {
      const host = document.createElement('div')
      const root = host.attachShadow({ mode: 'open' })
      const button = document.createElement('button')
      root.append(button)
      document.body.append(host)
      return { root, path: [button, root, host, document.body, document, window] }
    })
    for (const { path } of paths) {
      click(path)
    }
    await vi.advanceTimersByTimeAsync(3000)
    // The 64th shadow root exceeds the budget (which also includes document), discarding the
    // old window. Feedback in a released root must not classify the newly admitted click.
    paths[0]?.root.dispatchEvent(new Event('scroll'))
    expect(exporter.getFinishedSpans()).toEqual([])
    await vi.advanceTimersByTimeAsync(4000)
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['browser.dead_click'])
  })
})
