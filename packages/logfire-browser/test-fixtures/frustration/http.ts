import { configureFrontend } from '@pydantic/logfire-browser'
import { signalFeed } from './signals'

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) {
    throw new Error(`Missing fixture element ${id}`)
  }
  return found
}

const cleanup = configureFrontend({
  baseUrl: location.origin,
  token: 'local-fixture-frontend-token',
  rum: {
    webVitals: false,
    frustration: { deadClicks: true },
    session: { getRouteName: () => '/checkout' },
  },
  batchSpanProcessorConfig: { scheduledDelayMillis: 1000, maxExportBatchSize: 16 },
  sessionReplay: {
    load: async () => import('@pydantic/logfire-session-replay'),
    sessionSampleRate: 1,
    flushIntervalMs: 5000,
    minSessionDurationMs: 0,
    captureConsole: false,
  },
  spanProcessors: [signalFeed()],
})
await cleanup.sessionReplay?.flush()
const status = document.querySelector('[role="status"]')
if (status === null || cleanup.sessionReplay?.recording !== true) {
  throw new Error('Replay did not start')
}
status.textContent = 'ready'

for (const [id, endpoint, statusId, text] of [
  ['add', 'cart', 'cart-status', '✓ Added to your bag'],
  ['shipping', 'shipping', 'shipping-status', 'Free delivery · arrives Thursday'],
] as const) {
  element(id).addEventListener('click', () => {
    fetch(`/fixture/${endpoint}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Fixture request failed')
        }
        await response.json()
        element(statusId).textContent = text
      })
      .catch(() => {
        element(statusId).textContent = 'Request failed'
      })
  })
}
element('stop').addEventListener('click', () => {
  cleanup().then(
    () => {
      status.textContent = 'SDK stopped'
    },
    () => {
      status.textContent = 'SDK shutdown failed'
    }
  )
})
