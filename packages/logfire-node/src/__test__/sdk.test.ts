/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { MockInstance } from 'vite-plus/test'
import type { HrTime } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import type { Instrumentation } from '@opentelemetry/instrumentation'

import { context, diag, metrics, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'

const mocks = vi.hoisted(() => {
  interface MockMetricReader {
    forceFlush: () => Promise<void>
    id: number
    shutdown: () => Promise<void>
  }

  interface MockVariableState {
    apiKey: unknown
    baseUrl: unknown
    providerConfigured: boolean
    resourceAttributes: Record<string, unknown>
  }

  const nodeSdkInstances: MockNodeSDK[] = []
  const logfireApiConfig = { otelScope: 'logfire', tracer: undefined as unknown }
  const configureVariablesCalls: unknown[][] = []
  const createdMetricReaders: MockMetricReader[] = []
  const metricReaderCallCounts = new Map<number, { forceFlush: number; shutdown: number }>()
  const shutdownPromises: Promise<void>[] = []
  let evalForceFlushCalls = 0
  let evalShutdownCalls = 0
  let logForceFlushCalls = 0
  let logShutdownCalls = 0
  let metricReaderId = 0
  let metricReaderForceFlushCalls = 0
  let metricReaderShutdownCalls = 0
  const reportErrorCalls: unknown[][] = []
  let shutdownVariablesCalls = 0
  let traceForceFlushCalls = 0
  const traceOnEndSpans: unknown[] = []
  const traceOnStartSpans: unknown[] = []
  let traceShutdownCalls = 0
  let variableState = makeEmptyVariableState()

  const logProcessor = {
    forceFlush: async () => {
      logForceFlushCalls++
      return Promise.resolve()
    },
    onEmit: () => undefined,
    shutdown: async () => {
      logShutdownCalls++
      return Promise.resolve()
    },
  }
  const traceProcessor = {
    forceFlush: async () => {
      traceForceFlushCalls++
      return Promise.resolve()
    },
    onEnd: (span: unknown) => {
      traceOnEndSpans.push(span)
    },
    onStart: (span: unknown) => {
      traceOnStartSpans.push(span)
    },
    shutdown: async () => {
      traceShutdownCalls++
      return Promise.resolve()
    },
  }
  const evalProcessor = {
    forceFlush: async () => {
      evalForceFlushCalls++
      return Promise.resolve()
    },
    onEnd: () => undefined,
    onStart: () => undefined,
    shutdown: async () => {
      evalShutdownCalls++
      return Promise.resolve()
    },
  }

  class MockNodeSDK {
    options: {
      logRecordProcessors?: { shutdown: () => Promise<void> }[]
      metricReaders?: { shutdown: () => Promise<void> }[]
      resource?: { attributes: Record<string, unknown> }
      spanProcessors?: { shutdown: () => Promise<void> }[]
    }
    shutdownPromise: Promise<void> | undefined
    shutdownCalls = 0

    constructor(options: MockNodeSDK['options']) {
      this.options = options
      this.shutdownPromise = shutdownPromises.shift()
      nodeSdkInstances.push(this)
    }

    async shutdown(): Promise<void> {
      this.shutdownCalls++
      await Promise.all([
        ...(this.options.spanProcessors?.map(async (processor) => processor.shutdown()) ?? []),
        ...(this.options.logRecordProcessors?.map(async (processor) => processor.shutdown()) ?? []),
        ...(this.options.metricReaders?.map(async (reader) => reader.shutdown()) ?? []),
      ])
      await this.shutdownPromise
    }

    start(): void {
      return undefined
    }
  }

  function makeEmptyVariableState(): MockVariableState {
    return {
      apiKey: undefined,
      baseUrl: undefined,
      providerConfigured: false,
      resourceAttributes: {},
    }
  }

  function toRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  }

  function configureVariables(options: unknown, runtime: unknown) {
    configureVariablesCalls.push([options, runtime])
    const runtimeOptions = toRecord(runtime)
    variableState = {
      apiKey: runtimeOptions['apiKey'],
      baseUrl: runtimeOptions['baseUrl'],
      providerConfigured: options !== false,
      resourceAttributes: { ...toRecord(runtimeOptions['resourceAttributes']) },
    }
  }

  function createMetricReader(): MockMetricReader {
    const id = ++metricReaderId
    metricReaderCallCounts.set(id, { forceFlush: 0, shutdown: 0 })
    const reader = {
      id,
      forceFlush: async () => {
        metricReaderForceFlushCalls++
        const counts = metricReaderCallCounts.get(id)
        if (counts !== undefined) {
          counts.forceFlush++
        }
        return Promise.resolve()
      },
      shutdown: async () => {
        metricReaderShutdownCalls++
        const counts = metricReaderCallCounts.get(id)
        if (counts !== undefined) {
          counts.shutdown++
        }
        return Promise.resolve()
      },
    }
    createdMetricReaders.push(reader)
    return reader
  }

  return {
    configureVariables,
    configureVariablesCalls,
    createdMetricReaders,
    createMetricReader,
    evalProcessor,
    get evalForceFlushCalls() {
      return evalForceFlushCalls
    },
    get evalShutdownCalls() {
      return evalShutdownCalls
    },
    get logForceFlushCalls() {
      return logForceFlushCalls
    },
    logfireApiConfig,
    logProcessor,
    get logShutdownCalls() {
      return logShutdownCalls
    },
    get metricReaderForceFlushCalls() {
      return metricReaderForceFlushCalls
    },
    get metricReaderShutdownCalls() {
      return metricReaderShutdownCalls
    },
    metricReaderCallCounts,
    MockNodeSDK,
    nodeSdkInstances,
    reset() {
      logfireApiConfig.otelScope = 'logfire'
      logfireApiConfig.tracer = undefined
      configureVariablesCalls.length = 0
      createdMetricReaders.length = 0
      evalForceFlushCalls = 0
      evalShutdownCalls = 0
      logForceFlushCalls = 0
      logShutdownCalls = 0
      metricReaderCallCounts.clear()
      metricReaderForceFlushCalls = 0
      metricReaderId = 0
      metricReaderShutdownCalls = 0
      reportErrorCalls.length = 0
      shutdownVariablesCalls = 0
      shutdownPromises.length = 0
      traceForceFlushCalls = 0
      traceOnEndSpans.length = 0
      traceOnStartSpans.length = 0
      traceShutdownCalls = 0
      variableState = makeEmptyVariableState()
      nodeSdkInstances.length = 0
    },
    queueShutdownPromise(promise: Promise<void>) {
      shutdownPromises.push(promise)
    },
    reportErrorCalls,
    get shutdownVariablesCalls() {
      return shutdownVariablesCalls
    },
    shutdownVariables: async () => {
      shutdownVariablesCalls++
      variableState = makeEmptyVariableState()
      return Promise.resolve()
    },
    get traceForceFlushCalls() {
      return traceForceFlushCalls
    },
    traceOnEndSpans,
    traceOnStartSpans,
    get traceShutdownCalls() {
      return traceShutdownCalls
    },
    traceProcessor,
    get variableState() {
      return variableState
    },
  }
})

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}))

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mocks.MockNodeSDK,
}))

vi.mock('logfire', async () => {
  const [{ Level }, { PendingSpanProcessor }, { TailSamplingProcessor }, { ULIDGenerator }] = await Promise.all([
    import('../../../logfire-api/src/levels'),
    import('../../../logfire-api/src/PendingSpanProcessor'),
    import('../../../logfire-api/src/TailSamplingProcessor'),
    import('../../../logfire-api/src/ULIDGenerator'),
  ])
  return {
    Level,
    logfireApiConfig: mocks.logfireApiConfig,
    PendingSpanProcessor,
    reportError: (...args: unknown[]) => {
      mocks.reportErrorCalls.push(args)
    },
    TailSamplingProcessor,
    ULIDGenerator,
  }
})

vi.mock('logfire/evals', () => ({
  getEvalsSpanProcessor: () => mocks.evalProcessor,
}))

vi.mock('logfire/vars', () => ({
  configureVariables: (...args: unknown[]) => {
    mocks.configureVariables(args[0], args[1])
  },
  shutdownVariables: async () => mocks.shutdownVariables(),
}))

vi.mock('../logsExporter', () => ({
  logfireLogRecordProcessor: () => mocks.logProcessor,
}))

vi.mock('../metricExporter', () => ({
  periodicMetricReader: () => mocks.createMetricReader(),
}))

vi.mock('../traceExporter', () => ({
  logfireSpanProcessor: () => mocks.traceProcessor,
}))

import { forceFlush, shutdown, start } from '../sdk'
import { logfireConfig } from '../logfireConfig'
import { PendingSpanProcessor, TailSamplingProcessor } from 'logfire'

type AnyProcessListener = (...args: unknown[]) => void

let processOnSpy: MockInstance<typeof process.on>
let processEmitSpy: MockInstance<typeof process.emit>
let processKillSpy: MockInstance<typeof process.kill>
let processListenersSpy: MockInstance<typeof process.listeners>
let processRemoveListenerSpy: MockInstance<typeof process.removeListener>
const processListenerRegistry = new Map<string | symbol, AnyProcessListener[]>()
const originalOtelResourceAttributes = process.env['OTEL_RESOURCE_ATTRIBUTES']

function getProcessListeners(event: string | symbol): AnyProcessListener[] {
  return processListenerRegistry.get(event) ?? []
}

function getLatestProcessListener(event: string | symbol): AnyProcessListener {
  const listeners = getProcessListeners(event)
  const listener = listeners[listeners.length - 1]
  expect(listener).toBeDefined()
  if (listener === undefined) {
    throw new Error(`expected ${String(event)} listener`)
  }
  return listener
}

function getLatestResourceAttributes(): Record<string, unknown> {
  const instance = mocks.nodeSdkInstances[mocks.nodeSdkInstances.length - 1]
  expect(instance).toBeDefined()
  if (instance === undefined) {
    throw new Error('expected NodeSDK mock instance')
  }
  return (instance.options as { resource: { attributes: Record<string, unknown> } }).resource.attributes
}

function getLatestVariablesRuntimeOptions(): { resourceAttributes: Record<string, unknown> } {
  const call = mocks.configureVariablesCalls[mocks.configureVariablesCalls.length - 1]
  expect(call).toBeDefined()
  if (call === undefined) {
    throw new Error('expected configureVariables call')
  }
  return call[1] as { resourceAttributes: Record<string, unknown> }
}

async function waitForBackgroundLifecycle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function getLatestSpanProcessors(): SpanProcessor[] {
  const instance = mocks.nodeSdkInstances[mocks.nodeSdkInstances.length - 1]
  expect(instance).toBeDefined()
  if (instance === undefined) {
    throw new Error('expected NodeSDK mock instance')
  }
  return (instance.options as { spanProcessors: SpanProcessor[] }).spanProcessors
}

function getLatestMetricReaders(): { forceFlush: () => Promise<void>; id?: number; shutdown: () => Promise<void> }[] {
  const instance = mocks.nodeSdkInstances[mocks.nodeSdkInstances.length - 1]
  expect(instance).toBeDefined()
  if (instance === undefined) {
    throw new Error('expected NodeSDK mock instance')
  }
  return (
    (instance.options as { metricReaders?: { forceFlush: () => Promise<void>; id?: number; shutdown: () => Promise<void> }[] })
      .metricReaders ?? []
  )
}

function makeReadableSpan(): Span {
  const traceId = '11111111111111111111111111111111'
  const spanId = '2222222222222222'
  const startTime: HrTime = [1000, 0]
  return {
    attributes: { 'logfire.span_type': 'span' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    duration: [0, 0] as HrTime,
    ended: false,
    endTime: [0, 0] as HrTime,
    events: [],
    instrumentationScope: { name: 'test-scope' },
    isRecording: () => true,
    kind: SpanKind.INTERNAL,
    links: [],
    name: 'test span',
    resource: { attributes: {} },
    spanContext: () => ({ isRemote: false, spanId, traceFlags: TraceFlags.SAMPLED, traceId }),
    startTime,
    status: { code: SpanStatusCode.UNSET },
  } as unknown as Span
}

function fakeInstrumentation() {
  const state = { disableCalls: 0, enabled: true }
  const instrumentation = {
    disable: () => {
      state.disableCalls++
      state.enabled = false
    },
    enable: () => {
      state.enabled = true
    },
  } as unknown as Instrumentation
  return { instrumentation, state }
}

describe('sdk lifecycle helpers', () => {
  beforeEach(() => {
    mocks.reset()
    processListenerRegistry.clear()
    delete process.env['OTEL_RESOURCE_ATTRIBUTES']
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [],
      apiKey: undefined,
      codeSource: undefined,
      deploymentEnvironment: undefined,
      instrumentations: [],
      metrics: undefined,
      resourceAttributes: {},
      sampling: undefined,
      serviceName: undefined,
      serviceVersion: undefined,
      variables: undefined,
      variablesBaseUrl: undefined,
    })
    processEmitSpy = vi.spyOn(process, 'emit')
    processOnSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      const listeners = getProcessListeners(event)
      listeners.push(listener as AnyProcessListener)
      processListenerRegistry.set(event, listeners)
      return process
    })
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    processListenersSpy = vi.spyOn(process, 'listeners').mockImplementation((event) => {
      return [...getProcessListeners(event)] as ReturnType<typeof process.listeners>
    })
    processRemoveListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation((event, listener) => {
      processListenerRegistry.set(
        event,
        getProcessListeners(event).filter((currentListener) => currentListener !== listener)
      )
      return process
    })
  })

  afterEach(async () => {
    await shutdown()
    if (originalOtelResourceAttributes === undefined) {
      delete process.env['OTEL_RESOURCE_ATTRIBUTES']
    } else {
      process.env['OTEL_RESOURCE_ATTRIBUTES'] = originalOtelResourceAttributes
    }
    vi.restoreAllMocks()
  })

  it('forceFlush flushes trace, eval, log, and metric processors', async () => {
    start()
    const metricReader = mocks.createdMetricReaders[0]
    expect(metricReader).toBeDefined()
    if (metricReader === undefined) {
      throw new Error('expected metric reader')
    }
    expect(getLatestMetricReaders()[0]).toBe(metricReader)

    await forceFlush()

    expect(mocks.traceForceFlushCalls).toBe(1)
    expect(mocks.evalForceFlushCalls).toBe(1)
    expect(mocks.logForceFlushCalls).toBe(1)
    expect(mocks.metricReaderForceFlushCalls).toBe(1)
    expect(mocks.metricReaderCallCounts.get(metricReader.id)).toEqual({ forceFlush: 1, shutdown: 0 })
  })

  it('installs pending-span support in the non-tail-sampled path', () => {
    start()

    const spanProcessors = getLatestSpanProcessors()

    expect(spanProcessors[0]).toBe(mocks.traceProcessor)
    expect(spanProcessors[1]).toBeInstanceOf(PendingSpanProcessor)
    expect(spanProcessors[2]).toBe(mocks.evalProcessor)
  })

  it('installs deferred pending-span support when tail sampling is enabled', () => {
    Object.assign(logfireConfig, {
      sampling: { tail: () => 1 },
    })

    start()

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBeInstanceOf(TailSamplingProcessor)
    expect(spanProcessors.slice(1).some((processor) => processor instanceof PendingSpanProcessor)).toBe(false)

    const tailProcessor = spanProcessors[0]
    if (tailProcessor === undefined) {
      throw new Error('expected tail sampling processor')
    }
    const span = makeReadableSpan()
    tailProcessor.onStart(span, ROOT_CONTEXT)

    expect(mocks.traceOnStartSpans).toEqual([span])
    expect(mocks.traceOnEndSpans).toHaveLength(1)
    expect((mocks.traceOnEndSpans[0] as ReadableSpan).attributes['logfire.span_type']).toBe('pending_span')
  })

  it('does not duplicate final span export through the pending-span processor', () => {
    start()
    const spanProcessors = getLatestSpanProcessors()
    const span = makeReadableSpan()

    for (const processor of spanProcessors) {
      processor.onStart(span, ROOT_CONTEXT)
    }
    expect(mocks.traceOnEndSpans).toHaveLength(1)
    expect((mocks.traceOnEndSpans[0] as ReadableSpan).attributes['logfire.span_type']).toBe('pending_span')

    for (const processor of spanProcessors) {
      processor.onEnd(span)
    }

    expect(mocks.traceOnEndSpans).toHaveLength(2)
    expect(mocks.traceOnEndSpans[1]).toBe(span)
  })

  it('forceFlush flushes configured additional span processors', async () => {
    let additionalForceFlushCalls = 0
    const additionalProcessor: SpanProcessor = {
      forceFlush: async () => {
        additionalForceFlushCalls++
        return Promise.resolve()
      },
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [additionalProcessor],
    })

    start()

    const instance = mocks.nodeSdkInstances[mocks.nodeSdkInstances.length - 1]
    expect((instance?.options as { spanProcessors: SpanProcessor[] }).spanProcessors).toContain(additionalProcessor)

    await forceFlush()

    expect(additionalForceFlushCalls).toBe(1)
  })

  it('forceFlush flushes configured additional metric readers through NodeSDK metricReaders', async () => {
    let additionalMetricForceFlushCalls = 0
    let additionalMetricShutdownCalls = 0
    const additionalMetricReader = {
      forceFlush: async () => {
        additionalMetricForceFlushCalls++
        return Promise.resolve()
      },
      shutdown: async () => {
        additionalMetricShutdownCalls++
        return Promise.resolve()
      },
    }
    Object.assign(logfireConfig, {
      metrics: {
        additionalReaders: [additionalMetricReader],
      },
    })

    start()
    const instance = mocks.nodeSdkInstances[mocks.nodeSdkInstances.length - 1]
    expect(instance?.options.metricReaders).toHaveLength(2)
    const defaultMetricReader = mocks.createdMetricReaders[0]
    expect(defaultMetricReader).toBeDefined()
    if (defaultMetricReader === undefined) {
      throw new Error('expected default metric reader')
    }
    expect(instance?.options.metricReaders?.[0]).toBe(defaultMetricReader)
    expect(instance?.options.metricReaders).toContain(additionalMetricReader)

    await forceFlush()

    expect(mocks.metricReaderForceFlushCalls).toBe(1)
    expect(additionalMetricForceFlushCalls).toBe(1)
    expect(mocks.metricReaderCallCounts.get(defaultMetricReader.id)).toEqual({ forceFlush: 1, shutdown: 0 })

    await shutdown({ flush: false })

    expect(mocks.metricReaderShutdownCalls).toBe(1)
    expect(additionalMetricShutdownCalls).toBe(1)
    expect(mocks.metricReaderCallCounts.get(defaultMetricReader.id)).toEqual({ forceFlush: 1, shutdown: 1 })
  })

  it('shutdown is idempotent and clears active processors', async () => {
    start()
    const instance = mocks.nodeSdkInstances[0]
    expect(instance).toBeDefined()
    if (instance === undefined) {
      throw new Error('expected NodeSDK mock instance')
    }

    await shutdown()
    await shutdown()

    expect(instance.shutdownCalls).toBe(1)

    mocks.reset()
    await forceFlush()

    expect(mocks.traceForceFlushCalls).toBe(0)
    expect(mocks.logForceFlushCalls).toBe(0)
  })

  it('shutdown skips the explicit pre-shutdown flush when flush is false', async () => {
    start()
    const instance = mocks.nodeSdkInstances[0]
    if (instance === undefined) {
      throw new Error('expected NodeSDK mock instance')
    }

    await shutdown({ flush: false })

    expect(mocks.traceForceFlushCalls).toBe(0)
    expect(mocks.evalForceFlushCalls).toBe(0)
    expect(mocks.logForceFlushCalls).toBe(0)
    expect(mocks.metricReaderForceFlushCalls).toBe(0)
    expect(instance.shutdownCalls).toBe(1)
    expect(mocks.shutdownVariablesCalls).toBe(1)
  })

  it('forceFlush rejects when the shared timeout expires', async () => {
    let shouldHang = true
    const additionalProcessor: SpanProcessor = {
      forceFlush: async () => {
        if (shouldHang) {
          await new Promise<void>(() => {
            // intentionally never resolves to drive the timeout path
          })
        }
      },
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [additionalProcessor],
    })
    start()

    await expect(forceFlush({ timeoutMillis: 1 })).rejects.toThrow('logfire SDK: forceFlush timed out')

    shouldHang = false
    await shutdown({ flush: false })
  })

  it('shutdown still closes the SDK when the pre-shutdown flush fails', async () => {
    const flushError = new Error('flush failed')
    const additionalProcessor: SpanProcessor = {
      forceFlush: async () => Promise.reject(flushError),
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [additionalProcessor],
    })
    start()
    const instance = mocks.nodeSdkInstances[0]
    if (instance === undefined) {
      throw new Error('expected NodeSDK mock instance')
    }

    await expect(shutdown()).rejects.toBe(flushError)

    expect(instance.shutdownCalls).toBe(1)
    expect(mocks.shutdownVariablesCalls).toBe(1)
    await forceFlush()
    expect(mocks.traceForceFlushCalls).toBe(1)
  })

  it('concurrent shutdown calls share one shutdown', async () => {
    start()
    const instance = mocks.nodeSdkInstances[0]
    if (instance === undefined) {
      throw new Error('expected NodeSDK mock instance')
    }

    const first = shutdown()
    const second = shutdown()
    await Promise.all([first, second])

    expect(instance.shutdownCalls).toBe(1)
    expect(mocks.shutdownVariablesCalls).toBe(1)
  })

  it('start shuts down the previous SDK and replaces process listeners', async () => {
    start()
    const first = mocks.nodeSdkInstances[0]
    if (first === undefined) {
      throw new Error('expected first NodeSDK mock instance')
    }
    const firstListenerCalls = processOnSpy.mock.calls.map(([event, listener]) => [event, listener])

    start()
    await waitForBackgroundLifecycle()

    expect(first.shutdownCalls).toBe(1)
    expect(mocks.nodeSdkInstances).toHaveLength(2)
    expect(processRemoveListenerSpy.mock.calls).toEqual(firstListenerCalls)
    expect(processOnSpy.mock.calls.map(([event]) => event)).toEqual([
      'beforeExit',
      'SIGTERM',
      'uncaughtExceptionMonitor',
      'unhandledRejection',
      'beforeExit',
      'SIGTERM',
      'uncaughtExceptionMonitor',
      'unhandledRejection',
    ])
  })

  it('pending shutdown from a previous runtime cannot clear a new runtime', async () => {
    let resolvePreviousShutdown!: () => void
    mocks.queueShutdownPromise(
      new Promise<void>((resolve) => {
        resolvePreviousShutdown = resolve
      })
    )
    start()

    let newRuntimeAdditionalForceFlushCalls = 0
    const newRuntimeAdditionalProcessor: SpanProcessor = {
      forceFlush: async () => {
        newRuntimeAdditionalForceFlushCalls++
        return Promise.resolve()
      },
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [newRuntimeAdditionalProcessor],
      apiKey: 'new-api-key',
      resourceAttributes: { plan: 'pro' },
      variables: {
        config: { variables: {} },
        instrument: false,
      },
      variablesBaseUrl: 'https://variables.example.com',
    })
    start()

    resolvePreviousShutdown()
    await waitForBackgroundLifecycle()
    await forceFlush()

    expect(newRuntimeAdditionalForceFlushCalls).toBe(1)
    expect(mocks.shutdownVariablesCalls).toBe(0)
    expect(mocks.variableState).toMatchObject({
      apiKey: 'new-api-key',
      baseUrl: 'https://variables.example.com',
      providerConfigured: true,
    })
    expect(mocks.variableState.resourceAttributes).toMatchObject({ plan: 'pro' })
  })

  it('start disables previous runtime globals and instrumentations before re-registering', () => {
    const traceDisableSpy = vi.spyOn(trace, 'disable')
    const metricsDisableSpy = vi.spyOn(metrics, 'disable')
    const propagationDisableSpy = vi.spyOn(propagation, 'disable')
    const contextDisableSpy = vi.spyOn(context, 'disable')
    const logsDisableSpy = vi.spyOn(logs, 'disable')
    const first = fakeInstrumentation()
    Object.assign(logfireConfig, { instrumentations: [first.instrumentation] })

    start()
    expect(traceDisableSpy).not.toHaveBeenCalled()
    expect(first.state.disableCalls).toBe(0)

    const second = fakeInstrumentation()
    Object.assign(logfireConfig, { instrumentations: [second.instrumentation] })
    start()

    expect(traceDisableSpy).toHaveBeenCalledTimes(1)
    expect(metricsDisableSpy).toHaveBeenCalledTimes(1)
    expect(propagationDisableSpy).toHaveBeenCalledTimes(1)
    expect(contextDisableSpy).toHaveBeenCalledTimes(1)
    expect(logsDisableSpy).toHaveBeenCalledTimes(1)
    expect(first.state.disableCalls).toBe(1)
    expect(second.state.disableCalls).toBe(0)
  })

  it('start retains an instrumentation instance reused by the replacement configuration', () => {
    const reused = fakeInstrumentation()
    Object.assign(logfireConfig, { instrumentations: [reused.instrumentation] })

    start()
    start()

    expect(reused.state.disableCalls).toBe(0)
    expect(reused.state.enabled).toBe(true)
  })

  it('shutdown releases owned globals; a later start does not disable again', async () => {
    const traceDisableSpy = vi.spyOn(trace, 'disable')
    start()
    await shutdown()

    expect(traceDisableSpy).toHaveBeenCalledTimes(1)

    start()

    expect(traceDisableSpy).toHaveBeenCalledTimes(1)
  })

  it('start re-fetches the shared API tracer after the SDK starts', () => {
    expect(mocks.logfireApiConfig.tracer).toBeUndefined()

    start()
    const firstTracer = mocks.logfireApiConfig.tracer
    expect(firstTracer).toBeDefined()

    start()

    expect(mocks.logfireApiConfig.tracer).toBeDefined()
    expect(mocks.logfireApiConfig.tracer).not.toBe(firstTracer)
  })

  it('does not install a SIGINT listener', () => {
    start()

    expect(processOnSpy.mock.calls.map(([event]) => event)).not.toContain('SIGINT')
    expect(getProcessListeners('SIGINT')).toEqual([])
  })

  it('beforeExit uses the shared shutdown promise when invoked repeatedly', async () => {
    let resolveShutdown!: () => void
    mocks.queueShutdownPromise(
      new Promise<void>((resolve) => {
        resolveShutdown = resolve
      })
    )
    start()
    const instance = mocks.nodeSdkInstances[0]
    if (instance === undefined) {
      throw new Error('expected NodeSDK mock instance')
    }

    const listener = getLatestProcessListener('beforeExit')
    listener()
    listener()
    await waitForBackgroundLifecycle()

    expect(instance.shutdownCalls).toBe(1)
    expect(mocks.shutdownVariablesCalls).toBe(1)

    resolveShutdown()
    await waitForBackgroundLifecycle()
  })

  it('SIGTERM snapshots listeners before shutdown and re-emits with process.kill when Logfire is the only listener', async () => {
    let resolveShutdown!: () => void
    mocks.queueShutdownPromise(
      new Promise<void>((resolve) => {
        resolveShutdown = resolve
      })
    )
    start()

    const listener = getLatestProcessListener('SIGTERM')
    listener()
    await waitForBackgroundLifecycle()

    expect(processKillSpy).not.toHaveBeenCalled()
    expect(processListenersSpy.mock.invocationCallOrder[0]).toBeLessThan(processRemoveListenerSpy.mock.invocationCallOrder[0] ?? Infinity)

    resolveShutdown()
    await waitForBackgroundLifecycle()

    expect(processKillSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(processEmitSpy.mock.calls.some(([event]) => (event as unknown) === 'SIGTERM')).toBe(false)
  })

  it('SIGTERM shuts down but does not re-emit when user SIGTERM listeners are present', async () => {
    start()
    const instance = mocks.nodeSdkInstances[0]
    if (instance === undefined) {
      throw new Error('expected NodeSDK mock instance')
    }
    const logfireListener = getLatestProcessListener('SIGTERM')
    process.on('SIGTERM', () => undefined)

    logfireListener()
    await waitForBackgroundLifecycle()

    expect(instance.shutdownCalls).toBe(1)
    expect(processKillSpy).not.toHaveBeenCalled()
  })

  it('SIGTERM re-emits when Logfire was already removed and no user SIGTERM listener remains', async () => {
    start()
    const listener = getLatestProcessListener('SIGTERM')
    process.removeListener('SIGTERM', listener)

    listener()
    await waitForBackgroundLifecycle()

    expect(processKillSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM')
  })

  it('SIGTERM does not re-emit when Logfire was already removed but user SIGTERM listeners remain', async () => {
    start()
    const listener = getLatestProcessListener('SIGTERM')
    process.removeListener('SIGTERM', listener)
    process.on('SIGTERM', () => undefined)

    listener()
    await waitForBackgroundLifecycle()

    expect(processKillSpy).not.toHaveBeenCalled()
  })

  it('SIGTERM handler swallows process.kill failures and logs them', async () => {
    const killError = new Error('kill failed')
    const warnSpy = vi.spyOn(diag, 'warn')
    processKillSpy.mockImplementation(() => {
      throw killError
    })
    start()

    const listener = getLatestProcessListener('SIGTERM')
    expect(() => {
      listener()
    }).not.toThrow()
    await waitForBackgroundLifecycle()

    expect(warnSpy).toHaveBeenCalledWith('logfire SDK: error re-emitting SIGTERM', killError)
  })

  it('SIGTERM uses the latest runtime listener after start is called twice', async () => {
    start()
    const first = mocks.nodeSdkInstances[0]
    if (first === undefined) {
      throw new Error('expected first NodeSDK mock instance')
    }
    start()
    await waitForBackgroundLifecycle()
    const second = mocks.nodeSdkInstances[1]
    if (second === undefined) {
      throw new Error('expected second NodeSDK mock instance')
    }

    const listener = getLatestProcessListener('SIGTERM')
    listener()
    await waitForBackgroundLifecycle()

    expect(first.shutdownCalls).toBe(1)
    expect(second.shutdownCalls).toBe(1)
    expect(processKillSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM')
  })

  it('unhandled rejection handler uses the complete best-effort flush path', async () => {
    let additionalForceFlushCalls = 0
    const additionalProcessor: SpanProcessor = {
      forceFlush: async () => {
        additionalForceFlushCalls++
        return Promise.resolve()
      },
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [additionalProcessor],
    })
    start()
    const listener = getLatestProcessListener('unhandledRejection')

    expect(() => {
      listener(new Error('boom'), Promise.resolve())
    }).not.toThrow()
    await waitForBackgroundLifecycle()

    expect(additionalForceFlushCalls).toBe(1)
    expect(mocks.traceForceFlushCalls).toBe(1)
    expect(mocks.evalForceFlushCalls).toBe(1)
    expect(mocks.logForceFlushCalls).toBe(1)
    expect(mocks.metricReaderForceFlushCalls).toBe(1)
    expect(mocks.reportErrorCalls).toHaveLength(1)
    expect(mocks.reportErrorCalls[0]?.[0]).toBe('boom')
    expect(mocks.reportErrorCalls[0]?.[1]).toBeInstanceOf(Error)
  })

  it('unhandled rejection handler swallows best-effort flush failures and logs them', async () => {
    const flushError = new Error('flush failed')
    const warnSpy = vi.spyOn(diag, 'warn')
    let rejectFlush = true
    const additionalProcessor: SpanProcessor = {
      forceFlush: async () => {
        if (rejectFlush) {
          return Promise.reject(flushError)
        }
        return Promise.resolve()
      },
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [additionalProcessor],
    })
    start()

    const listener = getLatestProcessListener('unhandledRejection')
    expect(() => {
      listener(new Error('boom'), Promise.resolve())
    }).not.toThrow()
    await waitForBackgroundLifecycle()

    expect(warnSpy).toHaveBeenCalledWith('logfire SDK: error flushing during unhandledRejection', flushError)
    rejectFlush = false
  })

  it('uncaughtExceptionMonitor schedules the complete best-effort flush path without throwing', async () => {
    let additionalForceFlushCalls = 0
    const additionalProcessor: SpanProcessor = {
      forceFlush: async () => {
        additionalForceFlushCalls++
        return Promise.resolve()
      },
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: async () => Promise.resolve(),
    }
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [additionalProcessor],
    })
    start()

    const listener = getLatestProcessListener('uncaughtExceptionMonitor')
    expect(() => {
      listener(new Error('boom'))
    }).not.toThrow()
    await waitForBackgroundLifecycle()

    expect(additionalForceFlushCalls).toBe(1)
    expect(mocks.traceForceFlushCalls).toBe(1)
    expect(mocks.evalForceFlushCalls).toBe(1)
    expect(mocks.logForceFlushCalls).toBe(1)
    expect(mocks.metricReaderForceFlushCalls).toBe(1)
    expect(mocks.reportErrorCalls).toHaveLength(1)
    expect(mocks.reportErrorCalls[0]?.[0]).toBe('boom')
    expect(mocks.reportErrorCalls[0]?.[1]).toBeInstanceOf(Error)
  })

  it('uncaughtExceptionMonitor swallows synchronous handler failures and logs them', () => {
    const handlerError = new Error('diag failed')
    start()
    const warnSpy = vi.spyOn(diag, 'warn')
    vi.spyOn(diag, 'info').mockImplementation(() => {
      throw handlerError
    })

    const listener = getLatestProcessListener('uncaughtExceptionMonitor')
    expect(() => {
      listener(new Error('boom'))
    }).not.toThrow()

    expect(warnSpy).toHaveBeenCalledWith('logfire SDK: error handling uncaughtExceptionMonitor', handlerError)
  })

  it('adds configured resource attributes to the NodeSDK resource', () => {
    Object.assign(logfireConfig, {
      resourceAttributes: {
        'app.installation.id': 'install-123',
        'service.namespace': 'my-company',
      },
      serviceName: 'node-service',
    })

    start()

    expect(getLatestResourceAttributes()).toMatchObject({
      'app.installation.id': 'install-123',
      'service.name': 'node-service',
      'service.namespace': 'my-company',
    })
    expect(getLatestVariablesRuntimeOptions().resourceAttributes).toMatchObject({
      'app.installation.id': 'install-123',
      'service.name': 'node-service',
      'service.namespace': 'my-company',
    })
  })

  it('keeps first-class resource options ahead of generic resource attributes', () => {
    Object.assign(logfireConfig, {
      deploymentEnvironment: 'production',
      resourceAttributes: {
        'deployment.environment.name': 'staging',
        'service.name': 'generic-service',
        'service.version': '0.0.1',
      },
      serviceName: 'configured-service',
      serviceVersion: '1.2.3',
    })

    start()

    expect(getLatestResourceAttributes()).toMatchObject({
      'deployment.environment.name': 'production',
      'service.name': 'configured-service',
      'service.version': '1.2.3',
    })
  })

  it('keeps OTEL_RESOURCE_ATTRIBUTES ahead of configured resource attributes', () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'service.namespace=env-company,app.installation.id=env-install'
    Object.assign(logfireConfig, {
      resourceAttributes: {
        'app.installation.id': 'configured-install',
        'service.namespace': 'configured-company',
      },
    })

    start()

    expect(getLatestResourceAttributes()).toMatchObject({
      'app.installation.id': 'env-install',
      'service.namespace': 'env-company',
    })
  })
})
