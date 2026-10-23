import { configureFrontend, getBrowserSessionId } from '../dist/index.js'
import type { FrustrationFixture } from './acceptance.types'

const mode = new URLSearchParams(location.search).get('mode')
let route = '/checkout'
const cleanup = configureFrontend({
  baseUrl: location.origin,
  token: 'local-fixture-frontend-token',
  autoInstrumentations: mode === 'auto',
  captureGlobalErrors: false,
  ...(mode === 'navigation-during-report'
    ? {
        spanProcessors: [
          {
            onStart(span) {
              if (span.name === 'browser.rage_click') {
                const original = location.href
                history.pushState({}, '', '/during-reporting')
                history.replaceState({}, '', original)
              }
            },
            onEnd: () => undefined,
            forceFlush: async () => Promise.resolve(),
            shutdown: async () => Promise.resolve(),
          },
        ],
      }
    : {}),
  ...(mode === 'errors' ? { profile: 'errors' as const } : {}),
  ...(mode === 'drop' ? { sampling: { head: 0 } } : {}),
  ...(mode === 'keep' ? { profile: 'errors' as const, sampling: { tail: () => 1 } } : {}),
  batchSpanProcessorConfig: { scheduledDelayMillis: 100, maxExportBatchSize: 8 },
  rum: {
    webVitals: false,
    frustration: { deadClicks: true, ignoreSelectors: ['[data-no-frustration]'] },
    session: { getRouteName: () => route },
  },
})

const fixture: FrustrationFixture = {
  session: getBrowserSessionId,
  setRoute: (value) => {
    route = value
  },
}
window.frustrationFixture = fixture
if (mode === 'auto') {
  document.getElementById('repeat')?.addEventListener('click', () => {
    fixture.handledClicks = (fixture.handledClicks ?? 0) + 1
  })
}

document.getElementById('slow')?.addEventListener('click', () => {
  setTimeout(() => {
    const feedback = document.getElementById('feedback')
    if (feedback !== null) {
      feedback.textContent = 'completed'
    }
  }, 3400)
})
document.getElementById('finish')?.addEventListener('click', () => {
  cleanup().then(
    () => {
      const status = document.getElementById('status')
      if (status !== null) {
        status.textContent = 'complete'
      }
    },
    () => {
      const status = document.getElementById('status')
      if (status !== null) {
        status.textContent = 'failed'
      }
    }
  )
})
const status = document.getElementById('status')
if (status !== null) {
  status.textContent = 'ready'
}
