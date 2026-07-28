import * as logfire from '../../dist/index.js'

type Phase = 'starting' | 'before-reload' | 'after-reload' | 'rotated' | 'complete' | 'failed'
type Scenario = 'normal' | 'hostile'

interface AcceptanceState {
  callbackCount: number
  error?: string
  phase: Phase
  scenario: Scenario
}

declare global {
  interface Window {
    __logfireRumDimensions: AcceptanceState
  }
}

const scenario: Scenario = window.location.pathname.startsWith('/hostile/') ? 'hostile' : 'normal'
const phaseKey = `logfire-rum-dimensions-phase-${scenario}`
const callbackCountKey = `logfire-rum-dimensions-callback-count-${scenario}`
const initialPhase = sessionStorage.getItem(phaseKey)
const state: AcceptanceState = {
  callbackCount: readCallbackCount(),
  phase: initialPhase === 'after-reload' ? 'after-reload' : 'starting',
  scenario,
}
Reflect.set(window, '__logfireRumDimensions', state)

let routeName = '/projects/:project_id'
let replayRuntime: { flush(): Promise<void> } | undefined
let markReplayReady!: () => void
const replayReady = new Promise<void>((resolve) => {
  markReplayReady = resolve
})
const uninstrumentedFetch = window.fetch
const uninstrumentedXhrOpen = Reflect.get(XMLHttpRequest.prototype, 'open')

const cleanup = logfire.configure({
  autoInstrumentations: {
    '@opentelemetry/instrumentation-document-load': { enabled: true },
    '@opentelemetry/instrumentation-fetch': { enabled: true },
    '@opentelemetry/instrumentation-user-interaction': { enabled: true, eventNames: ['click'] },
    '@opentelemetry/instrumentation-xml-http-request': { enabled: true },
  },
  batchSpanProcessorConfig: {
    maxExportBatchSize: 8,
    scheduledDelayMillis: 100,
  },
  metrics: {
    metricReaderConfig: {
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 2_000,
    },
    metricUrl: '/client-metrics',
  },
  rum: {
    session: {
      getRouteName:
        scenario === 'hostile'
          ? () => {
              throw new Error('hostile route callback')
            }
          : () => routeName,
      getSessionAttributes: scenario === 'hostile' ? hostileDimensions : normalDimensions,
      idleTimeoutMs: 2_000,
    },
    webVitals: {
      metrics: true,
      reportAllChanges: true,
    },
  },
  serviceName: `rum-dimensions-${scenario}`,
  sessionReplay: {
    captureConsole: false,
    captureNavigation: false,
    captureNetwork: false,
    flushIntervalMs: 60_000,
    ignoreUrlPatterns: [/\/receipts(?:\/|$)/u],
    load: async () => {
      const replayModule = await import('lf-rum-dimensions-recorder')
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
  await waitUntil(
    () => window.fetch !== uninstrumentedFetch && Reflect.get(XMLHttpRequest.prototype, 'open') !== uninstrumentedXhrOpen,
    'automatic fetch/XHR instrumentation'
  )

  if (scenario === 'hostile') {
    state.phase = 'before-reload'
    logfire.info('hostile-dimensions')
    document.querySelector<HTMLButtonElement>('#interaction')?.click()
    await replayRuntime?.flush()
    await cleanup()
    complete()
    return
  }

  if (initialPhase !== 'after-reload') {
    state.phase = 'before-reload'
    setStatus('before-reload')
    logfire.info('normal-before-reload')
    const durationSpan = logfire.startSpan('normal-duration')
    durationSpan.end()
    logfire.reportError('normal-error', new Error('fixture error'))
    await fetch('/api/fetch')
    await xhr('/api/xhr')
    document.querySelector<HTMLButtonElement>('#interaction')?.click()
    // Fetch/XHR instrumentation waits briefly for resource-timing entries
    // before ending its spans.
    await delay(500)
    await replayRuntime?.flush()
    sessionStorage.setItem(phaseKey, 'after-reload')
    await cleanup()
    window.location.reload()
    return
  }

  state.phase = 'after-reload'
  setStatus('after-reload')
  logfire.info('normal-after-reload')
  routeName = '/settings'
  await delay(2_100)
  logfire.info('normal-after-rotation')
  logfire.info('normal-callback-count', {
    'acceptance.callback_count': readCallbackCount(),
  })
  state.phase = 'rotated'
  setStatus('rotated')

  // Replay observes external browser-session rotation on its one-second poll.
  await delay(1_100)
  document.querySelector('#status')?.setAttribute('data-replay-session', 'rotated')
  await replayRuntime?.flush()
  await cleanup()

  const omittedRouteCleanup = logfire.configure({
    autoInstrumentations: false,
    batchSpanProcessorConfig: {
      maxExportBatchSize: 8,
      scheduledDelayMillis: 100,
    },
    rum: { session: true },
    serviceName: 'rum-dimensions-normal',
    traceUrl: '/client-traces',
  })
  logfire.info('normal-route-omitted')
  await omittedRouteCleanup()
  complete()
}

function normalDimensions(): Record<string, string | number | boolean> {
  const generation = incrementCallbackCount()
  return {
    account_tier: generation === 1 ? 'pro' : 'enterprise',
    app_region: 'eu',
    beta_user: true,
    generation,
  }
}

function hostileDimensions(): Record<string, string | number | boolean | undefined> {
  incrementCallbackCount()
  const dimensions: Record<string, unknown> = {
    Invalid: 'uppercase',
    account_tier: 'pro',
    invalid_infinity: Number.POSITIVE_INFINITY,
    invalid_nested: { secret: true },
    invalid_string: '🚀'.repeat(201),
    valid_unicode: '🚀'.repeat(200),
  }
  Object.defineProperty(dimensions, 'broken', {
    enumerable: true,
    get: () => {
      throw new Error('hostile property')
    },
  })
  for (let index = 0; index < 25; index++) {
    dimensions[`valid_${index.toString()}`] = index
  }
  return dimensions as Record<string, string | number | boolean | undefined>
}

function incrementCallbackCount(): number {
  const count = readCallbackCount() + 1
  sessionStorage.setItem(callbackCountKey, count.toString())
  state.callbackCount = count
  return count
}

function readCallbackCount(): number {
  return Number(sessionStorage.getItem(callbackCountKey) ?? '0')
}

function complete(): void {
  sessionStorage.removeItem(phaseKey)
  state.callbackCount = readCallbackCount()
  state.phase = 'complete'
  setStatus('complete')
}

function fail(error: unknown): void {
  state.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  state.phase = 'failed'
  setStatus('failed')
}

function setStatus(value: string): void {
  document.querySelector('#status')?.replaceChildren(value)
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function xhr(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('GET', url)
    request.addEventListener('load', () => {
      resolve()
    })
    request.addEventListener('error', () => {
      reject(new Error(`XHR failed: ${url}`))
    })
    request.send()
  })
}

async function waitUntil(predicate: () => boolean, description: string, deadline = Date.now() + 5_000): Promise<void> {
  if (predicate()) {
    return
  }
  if (Date.now() >= deadline) {
    throw new Error(`timed out waiting for ${description}`)
  }
  await delay(10)
  return waitUntil(predicate, description, deadline)
}
