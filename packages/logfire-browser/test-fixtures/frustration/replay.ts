import { configureFrontend, getBrowserSessionId } from '@pydantic/logfire-browser'
import type { SessionReplay } from '@pydantic/logfire-session-replay'

let recorder: SessionReplay | undefined
const cleanup = configureFrontend({
  baseUrl: location.origin,
  token: 'local-fixture-frontend-token',
  captureGlobalErrors: false,
  batchSpanProcessorConfig: { scheduledDelayMillis: 100, maxExportBatchSize: 8 },
  rum: {
    webVitals: false,
    frustration: { deadClicks: true },
    session: { idleTimeoutMs: 10000, getRouteName: () => '/checkout' },
  },
  sessionReplay: {
    load: async () => {
      const module = await import('@pydantic/logfire-session-replay')
      return {
        startSessionReplay(config) {
          recorder = module.startSessionReplay(config)
          return recorder
        },
      }
    },
    sessionSampleRate: 1,
    minSessionDurationMs: 0,
    flushIntervalMs: 60000,
    captureConsole: false,
  },
})

const fixture = {
  handledClicks: 0,
  session: getBrowserSessionId,
  recording: () => recorder?.getRecordingId(),
  flush: async () => cleanup.sessionReplay?.flush(),
  stop: cleanup,
}
Reflect.set(window, 'frustrationReplay', fixture)
document.getElementById('repeat')?.addEventListener('click', () => {
  fixture.handledClicks++
})
const status = document.querySelector('[role="status"]')
if (status !== null) {
  status.textContent = 'ready'
}
