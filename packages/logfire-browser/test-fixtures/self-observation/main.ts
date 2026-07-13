import * as logfire from '../../dist/index.js'

type Phase = 'starting' | 'observing' | 'stopping' | 'stopped' | 'failed'

interface AcceptanceState {
  cleanup: () => Promise<void>
  error?: string
  phase: Phase
}

declare global {
  interface Window {
    __logfireSelfObservation: AcceptanceState
  }
}

const state: AcceptanceState = {
  cleanup: async () => Promise.resolve(),
  phase: 'starting',
}
Reflect.set(window, '__logfireSelfObservation', state)

let markReplayReady!: () => void
const replayReady = new Promise<void>((resolve) => {
  markReplayReady = resolve
})

const cleanup = logfire.configure({
  autoInstrumentations: {
    '@opentelemetry/instrumentation-document-load': { enabled: false },
    '@opentelemetry/instrumentation-fetch': { enabled: true, ignoreUrls: [/\/receipts(?:\/|$)/u] },
    '@opentelemetry/instrumentation-user-interaction': { enabled: false },
    '@opentelemetry/instrumentation-xml-http-request': { enabled: true, ignoreUrls: [/\/receipts(?:\/|$)/u] },
  },
  batchSpanProcessorConfig: {
    maxExportBatchSize: 8,
    scheduledDelayMillis: 250,
  },
  metrics: {
    metricReaderConfig: {
      exportIntervalMillis: 1_000,
      exportTimeoutMillis: 1_000,
    },
    metricUrl: 'client-metrics',
  },
  rum: {
    webVitals: {
      metrics: true,
      reportAllChanges: true,
    },
  },
  serviceName: 'logfire-self-observation-acceptance',
  sessionReplay: {
    captureConsole: false,
    captureNavigation: false,
    captureNetwork: true,
    flushIntervalMs: 500,
    ignoreUrlPatterns: [/\/receipts(?:\/|$)/u],
    load: async () => {
      const replayModule = await import('lf-self-observation-recorder')
      return {
        startSessionReplay(config) {
          const runtime = replayModule.startSessionReplay(config)
          markReplayReady()
          return runtime
        },
      }
    },
    replayUrl: 'client-replay',
    sessionSampleRate: 1,
  },
  traceUrl: 'client-traces',
})

state.cleanup = async () => {
  if (state.phase === 'stopping' || state.phase === 'stopped') {
    return cleanup()
  }
  state.phase = 'stopping'
  await cleanup()
  state.phase = 'stopped'
  setStatus('stopped')
}

prepareAcceptance().catch(fail)

async function prepareAcceptance(): Promise<void> {
  try {
    await replayReady
    await waitForFcpMetric()
    await fetch('/receipts/reset', { method: 'POST' })
    await runAcceptance()
  } catch (error) {
    fail(error)
  }
}

async function waitForFcpMetric(): Promise<void> {
  return pollForFcpMetric(Date.now() + 10_000)
}

async function pollForFcpMetric(deadline: number): Promise<void> {
  const response = await fetch('/receipts/status')
  const status = (await response.json()) as { fcpMetric?: unknown }
  if (status.fcpMetric === true) {
    return
  }
  if (Date.now() >= deadline) {
    throw new Error('timed out waiting for the FCP metric receipt')
  }
  await delay(50)
  return pollForFcpMetric(deadline)
}

async function runAcceptance(): Promise<void> {
  try {
    await logfire.span('self-observation-manual', {
      callback: async () => {
        const response = await fetch('api/application')
        if (!response.ok) {
          throw new Error(`application request failed: ${String(response.status)}`)
        }
        await response.json()
      },
    })
    setStatus('observing')
    state.phase = 'observing'
  } catch (error) {
    fail(error)
  }
}

function fail(error: unknown): void {
  state.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  state.phase = 'failed'
  setStatus('failed')
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function setStatus(value: string): void {
  const status = document.querySelector('#status')
  if (status !== null) {
    status.textContent = value
  }
}
