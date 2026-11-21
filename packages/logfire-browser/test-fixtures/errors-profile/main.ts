import * as logfire from '../../dist/index.js'

let markReplayReady!: () => void
const replayReady = new Promise<void>((resolve) => {
  markReplayReady = resolve
})

const cleanup = logfire.configureFrontend({
  baseUrl: window.location.origin,
  batchSpanProcessorConfig: {
    maxExportBatchSize: 8,
    scheduledDelayMillis: 100,
  },
  profile: 'errors',
  sessionReplay: {
    captureConsole: false,
    captureNavigation: false,
    captureNetwork: false,
    flushIntervalMs: 60_000,
    load: async () => {
      const replayModule = await import('lf-errors-profile-recorder')
      return {
        startSessionReplay(config) {
          const runtime = replayModule.startSessionReplay(config)
          markReplayReady()
          return runtime
        },
      }
    },
    // The scenario records for less than the default 10s minimum, which would
    // otherwise discard the replay on cleanup().
    minSessionDurationMs: 0,
  },
  token: 'fixture-frontend-token',
})

// Registered in the same task as configureFrontend(), as a framework root registers its listeners.
on('healthy', () => {
  logfire.info('healthy click')
  fetch('/api/ok').catch(() => undefined)
})
on('handled', () => {
  logfire.reportError('Checkout failed', new Error('handled verification'))
})
on('failed-request', () => {
  fetch('/api/fail').catch(() => undefined)
})
on('uncaught', () => {
  throw new Error('uncaught verification')
})
on('finish', () => {
  cleanup().then(
    () => {
      setStatus('complete')
    },
    (error: unknown) => {
      setStatus(`failed: ${String(error)}`)
    }
  )
})

replayReady.then(
  () => {
    setStatus('ready')
  },
  (error: unknown) => {
    setStatus(`failed: ${String(error)}`)
  }
)

function on(id: string, listener: () => void): void {
  document.getElementById(id)?.addEventListener('click', listener)
}

function setStatus(status: string): void {
  const element = document.getElementById('status')
  if (element !== null) {
    element.textContent = status
  }
}
