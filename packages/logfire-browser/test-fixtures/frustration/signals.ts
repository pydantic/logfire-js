import type { SpanProcessor } from '@opentelemetry/sdk-trace-web'

// Diagnostic writes must not count as application feedback.
export function signalFeed(): SpanProcessor {
  const host = document.getElementById('signals')
  if (host === null) {
    throw new Error('Missing signal feed')
  }
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<p id="empty">No signals yet.</p>'
  const labels: Record<string, string> = {
    'browser.rage_click': 'Rapid repeated clicks',
    'browser.slow_click': 'Slow response observed',
    'browser.dead_click': 'No response observed',
  }
  return {
    onStart: () => undefined,
    onEnd(span) {
      const label = labels[span.name]
      if (label !== undefined) {
        root.getElementById('empty')?.remove()
        const row = document.createElement('p')
        row.textContent = label
        root.append(row)
      }
    },
    forceFlush: async () => Promise.resolve(),
    shutdown: async () => Promise.resolve(),
  }
}
