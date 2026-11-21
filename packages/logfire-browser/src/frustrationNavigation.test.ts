/** @vitest-environment jsdom */
/* eslint-disable @typescript-eslint/unbound-method -- Native methods retained for identity and called with their History receiver. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { observeFrustrationNavigations } from './frustrationNavigation'

let stop: (() => void) | undefined
const originalPush = Object.getOwnPropertyDescriptor(history, 'pushState')
const originalReplace = Object.getOwnPropertyDescriptor(history, 'replaceState')
afterEach(() => {
  stop?.()
  stop = undefined
  for (const [method, descriptor] of [
    ['pushState', originalPush],
    ['replaceState', originalReplace],
  ] as const) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(history, method)
    } else {
      Object.defineProperty(history, method, descriptor)
    }
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('frustration navigation observation', () => {
  it('uses native entry events without wrapping history and unsubscribes on cleanup', () => {
    const navigation = new EventTarget()
    vi.stubGlobal('navigation', navigation)
    const notify = vi.fn<() => void>()
    const original = history.pushState
    stop = observeFrustrationNavigations(notify)
    expect(history.pushState).toBe(original)
    navigation.dispatchEvent(new Event('currententrychange'))
    expect(notify).toHaveBeenCalledTimes(1)
    stop()
    navigation.dispatchEvent(new Event('currententrychange'))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('fallback observes successful history calls and restores original property ownership', () => {
    vi.stubGlobal('navigation', undefined)
    const notify = vi.fn<() => void>()
    stop = observeFrustrationNavigations(notify)
    history.pushState({}, '', '/other')
    history.replaceState({}, '', '/original')
    expect(notify).toHaveBeenCalledTimes(2)
    stop()
    expect(Object.getOwnPropertyDescriptor(history, 'pushState')).toEqual(originalPush)
    expect(Object.getOwnPropertyDescriptor(history, 'replaceState')).toEqual(originalReplace)
  })

  it('fallback does not count a failed navigation or break an application when observation fails', () => {
    vi.stubGlobal('navigation', undefined)
    const notify = vi.fn<() => void>(() => {
      throw new Error('observer failed')
    })
    stop = observeFrustrationNavigations(notify)
    expect(() => {
      history.pushState({}, '', '/success')
    }).not.toThrow()
    expect(() => {
      history.pushState({}, '', 'https://another-origin.invalid/')
    }).toThrow(DOMException)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('cleanup preserves another library’s wrapper and leaves retained callbacks inert', () => {
    vi.stubGlobal('navigation', undefined)
    const notify = vi.fn<() => void>()
    stop = observeFrustrationNavigations(notify)
    const captured = history.pushState
    const later: History['pushState'] = function (this: History, ...args: Parameters<History['pushState']>) {
      captured.apply(this, args)
    }
    history.pushState = later
    stop()
    expect(history.pushState).toBe(later)
    history.pushState({}, '', '/later')
    expect(notify).not.toHaveBeenCalled()
  })

  it('rolls back an installed wrapper when the second history method cannot be wrapped', () => {
    vi.stubGlobal('navigation', undefined)
    const currentHistory = history
    const original = currentHistory.pushState
    vi.stubGlobal(
      'history',
      new Proxy(currentHistory, {
        defineProperty(target, property, descriptor) {
          if (property === 'replaceState') {
            throw new Error('replaceState is locked')
          }
          return Reflect.defineProperty(target, property, descriptor)
        },
      })
    )
    expect(() => observeFrustrationNavigations(vi.fn<() => void>())).toThrow('replaceState is locked')
    expect(currentHistory.pushState).toBe(original)
    expect(Object.getOwnPropertyDescriptor(currentHistory, 'pushState')).toEqual(originalPush)
  })

  it('contains native navigation observer errors without disrupting later listeners', () => {
    const navigation = new EventTarget()
    vi.stubGlobal('navigation', navigation)
    stop = observeFrustrationNavigations(() => {
      throw new Error('observer failed')
    })
    const applicationListener = vi.fn<() => void>()
    navigation.addEventListener('currententrychange', applicationListener)
    navigation.dispatchEvent(new Event('currententrychange'))
    expect(applicationListener).toHaveBeenCalledTimes(1)
  })
})
