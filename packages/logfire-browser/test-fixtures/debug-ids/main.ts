import * as logfire from '../../dist/index.js'

// The inject snippet as the first statement of this module bundle; imports are evaluated before it either way.
;(() => {
  const stack = new Error().stack
  if (stack !== undefined) {
    const registry = (Reflect.get(globalThis, '_logfireDebugIds') as Record<string, string> | undefined) ?? {}
    registry[stack] = '2a4c6e8f-1b3d-4f5a-8c7e-9d0b1a2c3e4f'
    Reflect.set(globalThis, '_logfireDebugIds', registry)
  }
})()

declare global {
  interface Window {
    chargeCard: () => void
  }
}

// No serviceVersion: the exported service.version comes from the injected release.
const cleanup = logfire.configureFrontend({
  autoInstrumentations: false,
  baseUrl: window.location.origin,
  batchSpanProcessorConfig: { scheduledDelayMillis: 100 },
  rum: { webVitals: false },
  token: 'fixture-frontend-token',
})

function setStatus(status: string): void {
  const element = document.querySelector('#status')
  if (element !== null) {
    element.textContent = status
  }
}

document.querySelector('#uncaught')?.addEventListener('click', () => {
  setTimeout(() => {
    window.chargeCard()
  })
})
document.querySelector('#finish')?.addEventListener('click', () => {
  cleanup().then(
    () => {
      setStatus('complete')
    },
    (error: unknown) => {
      setStatus(`failed: ${String(error)}`)
    }
  )
})
setStatus('ready')
