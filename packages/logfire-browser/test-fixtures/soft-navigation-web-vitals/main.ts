import * as logfire from '../../dist/index.js'

interface AcceptanceState {
  error?: string
  phase: 'starting' | 'ready' | 'product' | 'complete' | 'failed'
  reportSoftNavs: boolean
  softNavigationSupported: boolean
  userAgent: string
}

declare global {
  interface Window {
    logfireSoftNavigationWebVitalsState: AcceptanceState
  }
}

const reportSoftNavs = new URL(location.href).searchParams.get('enabled') !== 'false'
const state: AcceptanceState = {
  phase: 'starting',
  reportSoftNavs,
  softNavigationSupported: PerformanceObserver.supportedEntryTypes.includes('soft-navigation'),
  userAgent: navigator.userAgent,
}
window.logfireSoftNavigationWebVitalsState = state

run().catch(fail)

async function run(): Promise<void> {
  await fetch('/receipts/reset', { method: 'POST' })
  let route = '/home'
  const cleanup = logfire.configure({
    batchSpanProcessorConfig: { maxExportBatchSize: 64, scheduledDelayMillis: 50 },
    rum: {
      session: {
        getRouteName: () => route,
      },
      webVitals: {
        reportAllChanges: true,
        reportSoftNavs,
      },
    },
    traceUrl: '/traces',
  })

  let navigationCount = 0
  const button = document.querySelector<HTMLButtonElement>('#navigate')
  const content = document.querySelector<HTMLElement>('#content')
  if (button === null || content === null) {
    throw new Error('fixture controls are missing')
  }

  button.addEventListener('click', () => {
    navigationCount++
    if (navigationCount === 1) {
      route = '/products/:id'
      history.pushState({}, '', '/products/123?token=secret#details')
      content.textContent = `Product ${'details '.repeat(1_000)}`
      state.phase = 'product'
      updateStatus()
      return
    }

    route = '/settings'
    history.pushState({}, '', '/settings')
    content.textContent = `Settings ${'preferences '.repeat(1_000)}`
    window.setTimeout(() => {
      cleanup()
        .then(async () => {
          state.phase = 'complete'
          updateStatus()
          await publishState()
        })
        .catch(fail)
    }, 2_000)
  })

  state.phase = 'ready'
  updateStatus()
}

function updateStatus(): void {
  const status = document.querySelector('#status')
  if (status !== null) {
    status.textContent = state.phase
  }
}

async function publishState(): Promise<void> {
  await fetch('/receipts/state', {
    body: JSON.stringify(state),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

function fail(error: unknown): void {
  state.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  state.phase = 'failed'
  updateStatus()
  publishState().catch(() => undefined)
}
