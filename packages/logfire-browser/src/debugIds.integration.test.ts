/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { configure, configureFrontend, reportError } from './index'
import type { LogfireConfigOptions } from './index'

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
      resultCallback({ code: 0 })
    }

    async shutdown(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

// Stands in for what the inject snippet writes when a bundle loads.
function setGlobal(name: '_debugIds' | '_logfireDebugIds' | '_logfireRelease', value: unknown): void {
  Reflect.set(globalThis, name, value)
}
const BUNDLE_URL = 'https://app.example.com/assets/index-a1b2.js'
const DEBUG_ID = '85314830-023f-4cf1-a267-535f4e37bb17'
// What the inject snippet captures with `new Error().stack` as the first statement of the bundle.
const REGISTRY_KEY = `Error\n    at ${BUNDLE_URL}:1:34`
const EXPECTED = `{"${BUNDLE_URL}":"${DEBUG_ID}"}`

let exporter = new InMemorySpanExporter()
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  Reflect.deleteProperty(globalThis, '_logfireDebugIds')
  Reflect.deleteProperty(globalThis, '_logfireRelease')
})

function start(options: Partial<LogfireConfigOptions> = {}): void {
  exporter = new InMemorySpanExporter()
  cleanup = configure({ spanProcessors: [new SimpleSpanProcessor(exporter)], traceUrl: '/client-traces', ...options })
}

function bundleError(message: string, bundleUrl = BUNDLE_URL): Error {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at onClick (${bundleUrl}:10:15)\n    at https://cdn.example.com/other.js:1:1`
  return error
}

function debugIdAttributes(): { event: unknown; span: unknown }[] {
  return exporter.getFinishedSpans().map((span) => ({
    event: span.events.find((event) => event.name === 'exception')?.attributes?.['logfire.debug_ids'],
    span: span.attributes['logfire.debug_ids'],
  }))
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('browser build identity', () => {
  it('stamps debug IDs and the injected release on an uncaught error', async () => {
    setGlobal('_logfireDebugIds', { [REGISTRY_KEY]: DEBUG_ID })
    setGlobal('_logfireRelease', '9f3c2ab')
    start()
    const error = bundleError('boom')

    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    await nextTask()

    expect(debugIdAttributes()).toEqual([{ event: EXPECTED, span: EXPECTED }])
    expect(exporter.getFinishedSpans().map((span) => span.resource.attributes['service.version'])).toEqual(['9f3c2ab'])
  })

  it('stamps debug IDs on an unhandled rejection', async () => {
    setGlobal('_logfireDebugIds', { [REGISTRY_KEY]: DEBUG_ID })
    start()
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = bundleError('rejected')

    window.dispatchEvent(event)
    await nextTask()

    expect(debugIdAttributes()).toEqual([{ event: EXPECTED, span: EXPECTED }])
  })

  it('keys debug IDs by the same URL the frontend URL policy leaves in the stack', () => {
    setGlobal('_logfireDebugIds', { [`Error\n    at ${BUNDLE_URL}?v=1:1:34`]: DEBUG_ID })
    exporter = new InMemorySpanExporter()
    const handle = configureFrontend({
      autoInstrumentations: false,
      baseUrl: 'https://logfire-us.pydantic.dev',
      captureGlobalErrors: false,
      rum: { webVitals: false },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      token: 'frontend-token',
    })
    cleanup = handle

    reportError('Checkout failed', bundleError('boom', `https://user:secret@app.example.com/assets/index-a1b2.js?v=1`))

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['logfire.debug_ids']).toBe(EXPECTED)
    expect(String(span?.attributes['exception.stacktrace'])).toContain(`at onClick (${BUNDLE_URL}:10:15)`)
  })

  it('prefers the configured service version and falls back to 0.0.1 without a release', async () => {
    setGlobal('_logfireRelease', '9f3c2ab')
    start({ serviceVersion: '2026.11.02' })
    reportError('Checkout failed', bundleError('configured'))
    const configured = exporter.getFinishedSpans()[0]?.resource.attributes['service.version']
    await cleanup?.()
    Reflect.deleteProperty(globalThis, '_logfireRelease')

    start()
    reportError('Checkout failed', bundleError('default'))

    expect([configured, exporter.getFinishedSpans()[0]?.resource.attributes['service.version']]).toEqual(['2026.11.02', '0.0.1'])
  })

  it('exports no debug ID attribute when the bundle has none', () => {
    setGlobal('_logfireDebugIds', { [`Error\n    at https://app.example.com/assets/lazy.js:1:34`]: DEBUG_ID })
    start()

    reportError('Checkout failed', bundleError('boom'))

    expect(debugIdAttributes()).toEqual([{ event: undefined, span: undefined }])
  })
})
