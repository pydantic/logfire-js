/** @vitest-environment jsdom */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, done: (result: { code: number }) => void): void {
      done({ code: 0 })
    }
    async shutdown(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

import { configure } from './index'

let cleanup: ReturnType<typeof configure> | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('public frustration configuration', () => {
  it.each(['pointerdown', 'keydown', 'wheel'])('rolls back when installing the %s intent listener fails', (failure) => {
    const nativeAdd = document.addEventListener.bind(document)
    const removes = vi.spyOn(document, 'removeEventListener')
    const adds = vi.spyOn(document, 'addEventListener').mockImplementation((name, listener, options) => {
      if (name === failure) {
        throw new Error('third-party gesture wrapper failed')
      }
      nativeAdd(name, listener, options)
    })
    expect(() => {
      cleanup = configure({
        traceUrl: 'http://logfire.test/v1/traces',
        autoInstrumentations: false,
        captureGlobalErrors: false,
        rum: { frustration: { deadClicks: true } },
      })
    }).not.toThrow()
    for (const [name, listener] of adds.mock.calls.filter(([type]) => ['click', 'pointerdown', 'keydown', 'wheel'].includes(type))) {
      expect(removes).toHaveBeenCalledWith(name, listener, true)
    }
  })

  it('rolls back all detector resources when a late listener registration fails', () => {
    vi.stubGlobal('navigation', undefined)
    const descriptors = Object.fromEntries(
      ['pushState', 'replaceState'].map((name) => [name, Object.getOwnPropertyDescriptor(history, name)])
    )
    const documentAdds = vi.spyOn(document, 'addEventListener')
    const documentRemoves = vi.spyOn(document, 'removeEventListener')
    const addWindowListener = window.addEventListener.bind(window)
    const windowAdds = vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => {
      if (name === 'blur') {
        throw new Error('third-party listener wrapper failed')
      }
      addWindowListener(name, listener, options)
    })
    const windowRemoves = vi.spyOn(window, 'removeEventListener')
    try {
      expect(() => {
        cleanup = configure({
          traceUrl: 'http://logfire.test/v1/traces',
          autoInstrumentations: false,
          captureGlobalErrors: false,
          rum: { frustration: true },
        })
      }).not.toThrow()
      const click = documentAdds.mock.calls.find(([name]) => name === 'click')?.[1]
      expect(typeof click).toBe('function')
      expect(documentRemoves).toHaveBeenCalledWith('click', click, true)
      const pagehide = windowAdds.mock.calls.filter(([name]) => name === 'pagehide').at(-1)?.[1]
      expect(windowRemoves).toHaveBeenCalledWith('pagehide', pagehide)
      expect(Object.getOwnPropertyDescriptor(history, 'pushState')).toEqual(descriptors['pushState'])
      expect(Object.getOwnPropertyDescriptor(history, 'replaceState')).toEqual(descriptors['replaceState'])
    } finally {
      // Also release the old implementation's leaked resources when demonstrating this test red.
      for (const [name, listener, options] of documentAdds.mock.calls) {
        document.removeEventListener(name, listener, options)
      }
      for (const [name, listener, options] of windowAdds.mock.calls) {
        window.removeEventListener(name, listener, options)
      }
      for (const name of ['pushState', 'replaceState']) {
        const descriptor = descriptors[name]
        if (descriptor === undefined) {
          Reflect.deleteProperty(history, name)
        } else {
          Object.defineProperty(history, name, descriptor)
        }
      }
    }
  })

  it('enables rage-only observation with session context and removes its listener on cleanup', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const observer = vi.spyOn(globalThis, 'MutationObserver')
    cleanup = configure({
      traceUrl: 'http://logfire.test/v1/traces',
      autoInstrumentations: false,
      captureGlobalErrors: false,
      rum: { frustration: true },
    })
    expect(add).toHaveBeenCalledWith('click', expect.any(Function), true)
    expect(observer).not.toHaveBeenCalled()
    await cleanup()
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function), true)
  })

  it('fails closed before installing listeners when experimental observer startup fails', () => {
    const add = vi.spyOn(document, 'addEventListener')
    vi.spyOn(globalThis, 'MutationObserver').mockImplementation(function () {
      throw new Error('observer unavailable')
    })
    expect(() => {
      cleanup = configure({
        traceUrl: 'http://logfire.test/v1/traces',
        autoInstrumentations: false,
        captureGlobalErrors: false,
        rum: { frustration: { deadClicks: true } },
      })
    }).not.toThrow()
    expect(add.mock.calls.filter(([type]) => type === 'click')).toEqual([])
  })

  it('rejects explicitly disabled session identity before starting a provider', () => {
    expect(() => configure({ traceUrl: 'http://logfire.test/v1/traces', rum: { session: false, frustration: true } })).toThrow(
      'rum.frustration requires browser session attributes'
    )
  })

  it('keeps listeners disabled unless explicitly enabled', () => {
    const add = vi.spyOn(document, 'addEventListener')
    cleanup = configure({
      traceUrl: 'http://logfire.test/v1/traces',
      autoInstrumentations: false,
      captureGlobalErrors: false,
      rum: { frustration: false },
    })
    expect(add.mock.calls.filter(([type]) => type === 'click')).toEqual([])
  })

  it('allows session tracking to be disabled when both detectors are disabled', () => {
    const add = vi.spyOn(document, 'addEventListener')
    expect(() => {
      cleanup = configure({
        traceUrl: 'http://logfire.test/v1/traces',
        autoInstrumentations: false,
        captureGlobalErrors: false,
        rum: { session: false, frustration: { rageClicks: false, deadClicks: false } },
      })
    }).not.toThrow()
    expect(add.mock.calls.filter(([type]) => type === 'click')).toEqual([])
  })
})
