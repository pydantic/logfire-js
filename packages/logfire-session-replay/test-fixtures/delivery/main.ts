import { startSessionReplay } from 'lf-replay-delivery'
import type { SessionReplay } from '@pydantic/logfire-session-replay'

type Scenario = 'csp' | 'retry-after' | 'unload' | 'utf8'
type Phase = 'starting' | 'ready' | 'complete' | 'failed'

interface DeliveryState {
  cspViolations: number
  error?: string
  errors: string[]
  phase: Phase
  scenario: Scenario
}

declare global {
  interface Window {
    __logfireReplayDelivery: DeliveryState
  }
}

const scenario = scenarioFromPath(location.pathname)
const state: DeliveryState = { cspViolations: 0, errors: [], phase: 'starting', scenario }
Reflect.set(window, '__logfireReplayDelivery', state)

run().catch(fail)

async function run(): Promise<void> {
  await fetch(`/fixture/reset?scenario=${scenario}`, { method: 'POST' })
  if (scenario === 'csp') {
    window.addEventListener('securitypolicyviolation', (event) => {
      if (event.effectiveDirective === 'worker-src' || event.violatedDirective === 'worker-src') {
        state.cspViolations += 1
      }
    })
  }

  const replay: SessionReplay = startSessionReplay({
    captureConsole: scenario === 'csp',
    captureNavigation: false,
    captureNetwork: scenario === 'utf8',
    flushIntervalMs: 60_000,
    getSessionId: () => `delivery-${scenario}`,
    headers: () => ({ 'X-Replay-Marker': scenario }),
    ignoreUrlPatterns: [/\/fixture\//u, /\/replay\//u],
    maxBufferBytes: 1_000_000,
    onError: (error: unknown) => {
      state.errors.push(error instanceof Error ? error.message : String(error))
    },
    replayUrl: `/replay/${scenario}`,
    sessionSampleRate: 1,
  })

  if (scenario === 'unload') {
    await prepareUnload()
    state.phase = 'ready'
    setStatus('ready')
    await saveState()
    return
  }
  if (scenario === 'csp') {
    console.log('csp-marker-one')
    await replay.flush()
    console.log('csp-marker-two')
    await replay.flush()
    await delay(100)
  } else if (scenario === 'retry-after') {
    await replay.flush()
  } else {
    await fetch('/application/fetch', { method: 'POST', body: 'é🚀' })
    await sendXhr('/application/xhr', 'é🚀')
    await delay(50)
    await replay.flush()
  }

  state.phase = 'complete'
  setStatus('complete')
  await saveState()
}

async function prepareUnload(): Promise<void> {
  const payload = document.querySelector('#payload')
  if (payload === null) {
    throw new Error('missing payload node')
  }
  payload.textContent = `unload-marker-one:${pseudoRandomText(26_000, 1)}`
  await nextFrame()
  payload.textContent = `unload-marker-two:${pseudoRandomText(26_000, 2)}`
  await nextFrame()
  await nextFrame()
}

function pseudoRandomText(length: number, seed: number): string {
  let random = seed >>> 0
  let value = ''
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let index = 0; index < length; index++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0
    value += alphabet[(random >>> 24) % alphabet.length]
  }
  return value
}

async function sendXhr(url: string, body: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.addEventListener('loadend', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`XHR failed: ${String(xhr.status)}`))
      }
    })
    xhr.send(body)
  })
}

async function saveState(): Promise<void> {
  await fetch(`/fixture/state?scenario=${scenario}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  })
}

function fail(error: unknown): void {
  state.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  state.phase = 'failed'
  setStatus('failed')
  saveState().catch(() => undefined)
}

function scenarioFromPath(pathname: string): Scenario {
  if (pathname.startsWith('/unload/')) {
    return 'unload'
  }
  if (pathname.startsWith('/csp/')) {
    return 'csp'
  }
  if (pathname.startsWith('/retry-after/')) {
    return 'retry-after'
  }
  if (pathname.startsWith('/utf8/')) {
    return 'utf8'
  }
  throw new Error(`unknown fixture path: ${pathname}`)
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve()
    })
  })
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function setStatus(value: string): void {
  const status = document.querySelector('#status')
  if (status !== null) {
    status.textContent = value
  }
}
