/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { installDocumentHideFlush } from './documentHideFlush'

let visibilityState: DocumentVisibilityState = 'visible'

function setVisibilityState(state: DocumentVisibilityState): void {
  visibilityState = state
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilityState })
}

afterEach(() => {
  setVisibilityState('visible')
})

describe('installDocumentHideFlush', () => {
  it('flushes after every document listener, whenever that listener registered', () => {
    const order: string[] = []
    const remove = installDocumentHideFlush(() => {
      order.push('flush')
    })
    const later = (): void => {
      order.push('application listener registered later')
    }
    document.addEventListener('visibilitychange', later)

    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))

    expect(order).toEqual(['application listener registered later', 'flush'])
    remove()
    document.removeEventListener('visibilitychange', later)
  })

  it('flushes once on a visibilitychange that does not bubble', () => {
    const flush = vi.fn<() => void>()
    const remove = installDocumentHideFlush(flush)

    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(flush).toHaveBeenCalledTimes(1)
    remove()
  })

  it('does not flush when the document becomes visible', () => {
    const flush = vi.fn<() => void>()
    const remove = installDocumentHideFlush(flush)

    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))

    expect(flush).not.toHaveBeenCalled()
    remove()
  })

  it('flushes on pagehide at window', () => {
    const flush = vi.fn<() => void>()
    const remove = installDocumentHideFlush(flush)

    window.dispatchEvent(new Event('pagehide'))

    expect(flush).toHaveBeenCalledTimes(1)
    remove()
  })

  it('stops flushing once removed', () => {
    const flush = vi.fn<() => void>()
    const remove = installDocumentHideFlush(flush)
    remove()

    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    window.dispatchEvent(new Event('pagehide'))

    expect(flush).not.toHaveBeenCalled()
  })
})
