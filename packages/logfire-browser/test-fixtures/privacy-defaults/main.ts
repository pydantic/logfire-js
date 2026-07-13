import * as logfire from '../../dist/index.js'

type Scenario = 'default' | 'opt-in'
type Phase = 'starting' | 'running' | 'complete' | 'failed'

interface AcceptanceState {
  error?: string
  phase: Phase
  scenario: Scenario
}

declare global {
  interface Window {
    __logfirePrivacyDefaults: AcceptanceState
  }
}

const scenario: Scenario = window.location.pathname.startsWith('/opt-in/') ? 'opt-in' : 'default'
const state: AcceptanceState = { phase: 'starting', scenario }
Reflect.set(window, '__logfirePrivacyDefaults', state)

let replayRuntime: { flush(): Promise<void> } | undefined
let markReplayReady!: () => void
const replayReady = new Promise<void>((resolve) => {
  markReplayReady = resolve
})

const rawPageAttributes = (url: URL) => ({ full: url.href, path: url.pathname })
const cleanup = logfire.configure({
  autoInstrumentations: false,
  batchSpanProcessorConfig: {
    maxExportBatchSize: 8,
    scheduledDelayMillis: 100,
  },
  rum: {
    session: scenario === 'opt-in' ? { urlAttributes: rawPageAttributes } : true,
  },
  serviceName: `privacy-defaults-${scenario}`,
  sessionReplay: {
    ...(scenario === 'opt-in'
      ? {
          captureConsole: true,
          maskAllText: false,
          redactUrlPatterns: [],
        }
      : {}),
    flushIntervalMs: 60_000,
    ignoreUrlPatterns: [/\/receipts(?:\/|$)/u],
    load: async () => {
      const replayModule = await import('lf-privacy-recorder')
      return {
        startSessionReplay(config) {
          const runtime = replayModule.startSessionReplay(config)
          replayRuntime = runtime
          markReplayReady()
          return runtime
        },
      }
    },
    replayUrl: '/client-replay',
    sessionSampleRate: 1,
  },
  traceUrl: '/client-traces',
})

run().catch(fail)

async function run(): Promise<void> {
  await replayReady
  await delay(100)
  await fetch('/receipts/reset', { method: 'POST' })
  state.phase = 'running'
  setStatus('running')

  logfire.info('privacy-defaults-page-span', { 'acceptance.scenario': scenario })
  await delay(50)

  const mutatedText = document.querySelector('#mutated-text')
  if (mutatedText === null) {
    throw new Error('missing mutation target')
  }
  mutatedText.textContent = 'mutated-visible-secret'
  await delay(50)

  const input = document.querySelector<HTMLInputElement>('#private-input')
  if (input === null) {
    throw new Error('missing input target')
  }
  input.value = 'input-event-secret'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await delay(50)

  console.warn('privacy-console-secret', { scenario })
  await fetch('/api/fetch?fetch_secret=visible#fetch_fragment=visible')
  await xhr('/api/xhr?xhr_secret=visible#xhr_fragment=visible')

  history.pushState({}, '', `/${scenario}/pushed?push_secret=visible#push_fragment=visible`)
  await delay(50)
  history.replaceState({}, '', `/${scenario}/replaced?replace_secret=visible#replace_fragment=visible`)
  await delay(50)
  await traverseBack()
  await delay(100)

  await replayRuntime?.flush()
  await cleanup()
  state.phase = 'complete'
  setStatus('complete')
}

async function traverseBack(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timed out waiting for popstate'))
    }, 2_000)
    window.addEventListener(
      'popstate',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
    history.back()
  })
}

async function xhr(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url)
    request.addEventListener('load', () => {
      resolve()
    })
    request.addEventListener('error', () => {
      reject(new Error(`XHR failed: ${url}`))
    })
    request.send('fixture-body')
  })
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
