/**
 * The flush that runs when the document hides, with the listeners placed where the browser
 * dispatches the events.
 *
 * Listeners on one target run in registration order, so a flush listener on `document` that
 * registers at startup runs before an application listener registered later, which may end the
 * very span the flush should carry. `visibilitychange` bubbles from `document` to `window`, so a
 * listener on `window` runs after every `document` listener, whenever each registered. A
 * `document` listener stays as the fallback for an event that does not bubble.
 *
 * `pagehide` is dispatched at `window`, so a listener on `document` never runs. A span that an
 * application ends in its own `pagehide` listener registered later is only carried when the
 * browser fires `visibilitychange` afterwards, which Chromium does on navigation.
 */
export function installDocumentHideFlush(flush: () => void): () => void {
  if (typeof document === 'undefined') {
    return () => undefined
  }
  const hasWindow = typeof window !== 'undefined'
  const flushIfHidden = () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  }
  const onDocumentVisibilityChange = (event: Event) => {
    if (event.bubbles && hasWindow) {
      return
    }
    flushIfHidden()
  }
  if (hasWindow) {
    window.addEventListener('visibilitychange', flushIfHidden)
    window.addEventListener('pagehide', flush)
  }
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)
  return () => {
    if (hasWindow) {
      window.removeEventListener('visibilitychange', flushIfHidden)
      window.removeEventListener('pagehide', flush)
    }
    document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
  }
}
