import { diag } from '@opentelemetry/api'

/** Synchronous resets, including away-and-back changes that a later URL comparison cannot see. */
export function observeFrustrationNavigations(onNavigate: () => void): () => void {
  let active = true
  const notify = () => {
    if (active) {
      try {
        onNavigate()
      } catch (error) {
        diag.error('logfire-browser: navigation observation failed', error)
      }
    }
  }
  const navigation = (globalThis as { navigation?: EventTarget }).navigation
  if (navigation !== undefined) {
    navigation.addEventListener('currententrychange', notify)
    return () => {
      active = false
      navigation.removeEventListener('currententrychange', notify)
    }
  }

  // Older browsers have no event for pushState/replaceState. Do not depend on the optional recorder.
  const restorers: (() => void)[] = []
  const stop = () => {
    active = false
    for (const restore of restorers) {
      try {
        restore()
      } catch (error) {
        diag.error('logfire-browser: navigation cleanup failed', error)
      }
    }
  }
  function install(method: 'pushState' | 'replaceState'): void {
    const original: (this: History, ...args: Parameters<History['pushState']>) => unknown = history[method]
    const descriptor = Object.getOwnPropertyDescriptor(history, method)
    const wrapped = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args)
      notify()
      return result
    }
    Object.defineProperty(history, method, {
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
      value: wrapped,
    })
    restorers.push(() => {
      // Never overwrite a wrapper another library installed after ours. Ours becomes inert.
      if (history[method] !== wrapped) {
        return
      }
      if (descriptor === undefined) {
        Reflect.deleteProperty(history, method)
      } else {
        Object.defineProperty(history, method, descriptor)
      }
    })
  }
  try {
    for (const method of ['pushState', 'replaceState'] as const) {
      install(method)
    }
  } catch (error) {
    stop()
    throw error
  }
  return stop
}
