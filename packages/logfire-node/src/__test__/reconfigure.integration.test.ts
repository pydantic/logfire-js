// Regression tests for https://github.com/pydantic/logfire-js/issues/167 —
// runs against the real NodeSDK and OTel API globals, so no module mocks here.
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { afterEach, describe, expect, it } from 'vite-plus/test'

import { configure, info, shutdown } from '../index'

function recordingProcessor() {
  const logNames: string[] = []
  const processor: SpanProcessor = {
    forceFlush: async () => Promise.resolve(),
    onEnd: (span) => {
      if (span.attributes['logfire.span_type'] === 'log') {
        logNames.push(span.name)
      }
    },
    onStart: () => undefined,
    shutdown: async () => Promise.resolve(),
  }
  return { logNames, processor }
}

function fakeInstrumentation() {
  // Mirrors InstrumentationBase: enabled at construction, disable() flips the
  // private state but getConfig().enabled stays true — which makes OTel's
  // registerInstrumentations skip enable() on registration.
  const state = { disableCalls: 0, enabled: true }
  const instrumentation = {
    disable: () => {
      state.disableCalls++
      state.enabled = false
    },
    enable: () => {
      state.enabled = true
    },
    getConfig: () => ({ enabled: true }),
    instrumentationName: 'fake-instrumentation',
    instrumentationVersion: '0.0.0',
    setConfig: () => undefined,
    setMeterProvider: () => undefined,
    setTracerProvider: () => undefined,
  } as unknown as Instrumentation
  return { instrumentation, state }
}

const base = { metrics: false as const, sendToLogfire: false, serviceName: 'reconfigure-itest' }

describe('reconfigure integration', () => {
  afterEach(async () => {
    await shutdown()
  })

  it('routes emissions to the latest configure() and stops feeding the previous one (CX-1)', () => {
    const gen1 = recordingProcessor()
    const gen2 = recordingProcessor()

    configure({ ...base, additionalSpanProcessors: [gen1.processor] })
    info('probe1')

    configure({ ...base, additionalSpanProcessors: [gen2.processor] })
    info('probe2')

    expect(gen1.logNames).toEqual(['probe1'])
    expect(gen2.logNames).toEqual(['probe2'])
  })

  it('re-registers after an awaited shutdown (CX-2)', async () => {
    const gen1 = recordingProcessor()
    const gen2 = recordingProcessor()

    configure({ ...base, additionalSpanProcessors: [gen1.processor] })
    info('probe1')
    await shutdown()

    configure({ ...base, additionalSpanProcessors: [gen2.processor] })
    info('probe2')

    expect(gen1.logNames).toEqual(['probe1'])
    expect(gen2.logNames).toEqual(['probe2'])
  })

  it('shutdown resolves promptly with buffered spans and no token (CX-3)', async () => {
    configure(base)
    info('buffered probe')

    // Regresses to a 30s deadline rejection when the void exporters do not
    // resolve the export callback; the suite timeout guards the hang.
    await expect(shutdown()).resolves.toBeUndefined()
  })

  it('keeps an instrumentation instance reused across configure() calls enabled', () => {
    const reused = fakeInstrumentation()

    configure({ ...base, instrumentations: [reused.instrumentation] })
    expect(reused.state.enabled).toBe(true)

    configure({ ...base, instrumentations: [reused.instrumentation] })
    expect(reused.state.enabled).toBe(true)
  })

  it('re-enables an instrumentation instance that skipped a configure() generation', () => {
    const reused = fakeInstrumentation()

    configure({ ...base, instrumentations: [reused.instrumentation] })
    configure(base)
    expect(reused.state.enabled).toBe(false)

    configure({ ...base, instrumentations: [reused.instrumentation] })
    expect(reused.state.enabled).toBe(true)
  })

  it('disables superseded consumer instrumentations on reconfigure and shutdown (CX-4)', async () => {
    const first = fakeInstrumentation()
    configure({ ...base, instrumentations: [first.instrumentation] })
    expect(first.state.disableCalls).toBe(0)

    const second = fakeInstrumentation()
    configure({ ...base, instrumentations: [second.instrumentation] })
    expect(first.state.disableCalls).toBe(1)
    expect(second.state.disableCalls).toBe(0)

    await shutdown()
    expect(second.state.disableCalls).toBe(1)
  })
})
