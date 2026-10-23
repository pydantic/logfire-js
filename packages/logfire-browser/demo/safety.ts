import { configureFrontend, getBrowserSessionId } from '../dist/index.js'
import type { BrowserConfigureHandle } from '../dist/index.js'
import type { SessionReplay } from '../../logfire-session-replay/dist/index.js'

const parameters = new URLSearchParams(location.search)
const detectorOnly = parameters.get('lifecycle') === 'detector'
const status = document.querySelector('[role="status"]')
const workload = document.getElementById('workload')
const feedback = document.getElementById('feedback')
if (status === null || workload === null || feedback === null) {
  throw new Error('Safety fixture markup is missing')
}
const nodes = Array.from({ length: 128 }, () => {
  const node = document.createElement('span')
  node.textContent = 'workload'
  workload.append(node)
  return node
})
const shows: boolean[] = []
window.addEventListener('pageshow', (event) => {
  shows.push(event.persisted)
})
let cleanup: BrowserConfigureHandle | undefined
let recorder: SessionReplay | undefined
let ticks = 0
let handled = 0
let uploadErrors = 0
const signals: string[] = []
let interval: ReturnType<typeof setInterval> | undefined

async function start(): Promise<void> {
  await cleanup?.()
  cleanup = configureFrontend({
    baseUrl: location.origin,
    token: 'local-safety-frontend-token',
    captureGlobalErrors: false,
    autoInstrumentations: !detectorOnly,
    rum: {
      webVitals: false,
      frustration: parameters.get('frustration') === 'off' ? false : { deadClicks: true },
      session: { idleTimeoutMs: 60000, getRouteName: () => '/safety' },
    },
    batchSpanProcessorConfig: { scheduledDelayMillis: 1000, maxQueueSize: 64, maxExportBatchSize: 8, exportTimeoutMillis: 1000 },
    sessionReplay: detectorOnly
      ? false
      : {
          load: async () => {
            const module = await import('../../logfire-session-replay/dist/index.js')
            return {
              startSessionReplay(config) {
                recorder = module.startSessionReplay(config)
                return recorder
              },
            }
          },
          captureConsole: false,
          sessionSampleRate: 1,
          minSessionDurationMs: 0,
          flushIntervalMs: 2000,
          maxBufferBytes: 128000,
          onError: () => {
            uploadErrors++
          },
        },
    spanProcessors: [
      {
        onStart: () => undefined,
        onEnd(span) {
          if (span.name.startsWith('browser.') && signals.length < 64) {
            signals.push(span.name)
          }
        },
        forceFlush: async () => Promise.resolve(),
        shutdown: async () => Promise.resolve(),
      },
    ],
  })
  await cleanup.sessionReplay?.flush()
}

const save = () => {
  handled++
  feedback.textContent = `Saved ${String(handled)}`
}
document.getElementById('healthy')?.addEventListener('click', save)
document.getElementById('healthy-again')?.addEventListener('click', save)
Reflect.set(window, 'frustrationSafety', {
  documentId: crypto.randomUUID(),
  shows,
  signals,
  session: getBrowserSessionId,
  recording: () => recorder?.getRecordingId(),
  stats: () => ({ ticks, handled, uploadErrors }),
  start,
  flush: async () => cleanup?.sessionReplay?.flush(),
  stop: async () => {
    await cleanup?.()
    cleanup = undefined
  },
  workload: (enabled: boolean) => {
    clearInterval(interval)
    interval = undefined
    if (enabled) {
      interval = setInterval(() => {
        ticks++
        const node = nodes[ticks % nodes.length]
        if (node !== undefined) {
          node.textContent = `Frame ${String(ticks)}`
        }
      }, 100)
    }
  },
})
await start()
status.textContent = 'ready'
