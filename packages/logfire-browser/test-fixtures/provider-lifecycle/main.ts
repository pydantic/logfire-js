import { context, propagation, trace } from '@opentelemetry/api'
import type { Context, TextMapPropagator, TextMapSetter } from '@opentelemetry/api'
import { ZoneContextManager } from '@opentelemetry/context-zone'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { InstrumentationBase } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'

import * as logfire from '../../dist/index.js'

type Scenario = 'application-owned' | 'sequential'
type Phase = 'starting' | 'complete' | 'failed'

interface AcceptanceState {
  activeContextChecks?: Record<string, boolean>
  activeOverlap?: string
  applicationPropagationAfterCleanup?: boolean
  cleaningOverlap?: string
  error?: string
  inactiveRecording?: boolean
  phase: Phase
  scenario: Scenario
  tailSamplingCalls?: number
}

declare global {
  interface Window {
    __logfireProviderLifecycle: AcceptanceState
  }
}

const scenario: Scenario = location.pathname.startsWith('/application-owned') ? 'application-owned' : 'sequential'
const state: AcceptanceState = { phase: 'starting', scenario }
Reflect.set(window, '__logfireProviderLifecycle', state)

run().catch(fail)

async function run(): Promise<void> {
  await fetch(`/receipts/reset?scenario=${scenario}`, { method: 'POST' })
  if (scenario === 'sequential') {
    await runSequential()
  } else {
    await runApplicationOwned()
  }
  const completeState = { ...state, phase: 'complete' as const }
  await fetch(`/receipts/state?scenario=${scenario}`, {
    body: JSON.stringify(completeState),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  Object.assign(state, completeState)
  setStatus('complete')
}

async function runSequential(): Promise<void> {
  const activeContextChecks: Record<string, boolean> = {}
  state.activeContextChecks = activeContextChecks
  const cachedTracer = trace.getTracer('fixture-cached-before-a')
  const instrumentation = new FixtureInstrumentation()
  const zoneContextManager = new ZoneContextManager()
  const cleanupA = logfire.configure({
    batchSpanProcessorConfig: { maxExportBatchSize: 32, scheduledDelayMillis: 50 },
    contextManager: zoneContextManager,
    instrumentations: [instrumentation],
    resourceAttributes: { generation: 'A' },
    serviceName: 'provider-lifecycle-a',
    traceUrl: '/traces/a?scenario=sequential',
  })

  state.activeOverlap = captureError(() => {
    logfire.configure({ traceUrl: '/traces/overlap?scenario=sequential' })
  })
  await emitGeneration('a', cachedTracer, instrumentation, activeContextChecks)

  const cleanupPromiseA = cleanupA()
  state.cleaningOverlap = captureError(() => {
    logfire.configure({ traceUrl: '/traces/overlap?scenario=sequential' })
  })
  await cleanupPromiseA
  state.inactiveRecording = cachedTracer.startSpan('inactive-between-generations').isRecording()

  const cleanupB = logfire.configure({
    batchSpanProcessorConfig: { maxExportBatchSize: 32, scheduledDelayMillis: 50 },
    instrumentations: [instrumentation],
    resourceAttributes: { generation: 'B' },
    sampling: {
      tail: () => {
        state.tailSamplingCalls = (state.tailSamplingCalls ?? 0) + 1
        return 1
      },
    },
    serviceName: 'provider-lifecycle-b',
    traceUrl: '/traces/b?scenario=sequential',
  })
  await emitGeneration('b', cachedTracer, instrumentation, activeContextChecks)
  await cleanupB()
}

async function emitGeneration(
  suffix: 'a' | 'b',
  cachedTracer: ReturnType<typeof trace.getTracer>,
  instrumentation: FixtureInstrumentation,
  activeContextChecks: Record<string, boolean>
): Promise<void> {
  await cachedTracer.startActiveSpan(`cached-parent-${suffix}`, async (parent) => {
    activeContextChecks[`cached-sync-${suffix}`] = trace.getSpan(context.active()) === parent
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        activeContextChecks[`cached-timer-${suffix}`] = trace.getSpan(context.active()) === parent
        cachedTracer.startSpan(`cached-child-${suffix}`).end()
        parent.end()
        resolve()
      }, 0)
    })
  })
  await logfire.span(`manual-parent-${suffix}`, {
    callback: async (parent) => {
      activeContextChecks[`manual-sync-${suffix}`] = trace.getSpan(context.active()) === parent
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          activeContextChecks[`manual-timer-${suffix}`] = trace.getSpan(context.active()) === parent
          logfire.startSpan(`manual-child-${suffix}`).end()
          resolve()
        }, 0)
      })
    },
  })
  instrumentation.emit(`instrumentation-${suffix}`)
}

async function runApplicationOwned(): Promise<void> {
  const applicationProvider = new WebTracerProvider({
    resource: resourceFromAttributes({ generation: 'application' }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: '/traces/app?scenario=application-owned' }), {
        maxExportBatchSize: 32,
        scheduledDelayMillis: 50,
      }),
    ],
  })
  if (!trace.setGlobalTracerProvider(applicationProvider)) {
    throw new Error('failed to install application tracer provider')
  }
  const applicationContext = new ZoneContextManager()
  if (!context.setGlobalContextManager(applicationContext)) {
    throw new Error('failed to install application context manager')
  }
  applicationContext.enable()
  const applicationPropagator = new ApplicationPropagator()
  if (!propagation.setGlobalPropagator(applicationPropagator)) {
    throw new Error('failed to install application propagator')
  }

  const applicationTracer = trace.getTracer('fixture-application-owner')
  applicationTracer.startSpan('application-before').end()
  const instrumentation = new FixtureInstrumentation()
  const cleanupLogfire = logfire.configure({
    batchSpanProcessorConfig: { maxExportBatchSize: 32, scheduledDelayMillis: 50 },
    instrumentations: [instrumentation],
    resourceAttributes: { generation: 'logfire' },
    serviceName: 'provider-lifecycle-logfire',
    traceUrl: '/traces/a?scenario=application-owned',
  })
  applicationTracer.startSpan('application-during').end()
  logfire.startSpan('manual-logfire').end()
  instrumentation.emit('instrumentation-logfire')
  await cleanupLogfire()

  await applicationTracer.startActiveSpan('application-after-parent', async (parent) => {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        applicationTracer.startSpan('application-after-child').end()
        parent.end()
        resolve()
      }, 0)
    })
  })
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  state.applicationPropagationAfterCleanup = carrier['x-application-propagator'] === 'present'
  await applicationProvider.forceFlush()
  await applicationProvider.shutdown()
}

class FixtureInstrumentation extends InstrumentationBase {
  constructor() {
    super('provider-lifecycle-fixture', '1.0.0', { enabled: false })
  }

  emit(name: string): void {
    this.tracer.startSpan(name).end()
  }

  override enable(): void {
    return undefined
  }

  override disable(): void {
    return undefined
  }

  protected init(): void {
    return undefined
  }
}

class ApplicationPropagator implements TextMapPropagator {
  extract(parentContext: Context): Context {
    return parentContext
  }

  fields(): string[] {
    return ['x-application-propagator']
  }

  inject<Carrier>(
    _activeContext: Context,
    carrier: Carrier,
    setter: TextMapSetter<Carrier> = {
      set(target, key, value) {
        Reflect.set(target as object, key, value)
      },
    }
  ): void {
    setter.set(carrier, 'x-application-propagator', 'present')
  }
}

function captureError(callback: () => void): string | undefined {
  try {
    callback()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function fail(error: unknown): void {
  state.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  state.phase = 'failed'
  setStatus('failed')
}

function setStatus(value: string): void {
  const status = document.querySelector('#status')
  if (status !== null) {
    status.textContent = value
  }
}
