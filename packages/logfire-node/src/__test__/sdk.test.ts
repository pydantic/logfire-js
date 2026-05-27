/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { MockInstance } from 'vite-plus/test'
import type { HrTime } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api'

const mocks = vi.hoisted(() => {
  const nodeSdkInstances: MockNodeSDK[] = []
  const configureVariablesCalls: unknown[][] = []
  const shutdownPromises: Promise<void>[] = []
  let evalForceFlushCalls = 0
  let evalShutdownCalls = 0
  let logForceFlushCalls = 0
  let logShutdownCalls = 0
  let metricReaderId = 0
  let metricReaderForceFlushCalls = 0
  let metricReaderShutdownCalls = 0
  let shutdownVariablesCalls = 0
  let traceForceFlushCalls = 0
  const traceOnEndSpans: unknown[] = []
  const traceOnStartSpans: unknown[] = []
  let traceShutdownCalls = 0

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

  function createMetricReader() {
    const id = ++metricReaderId
    return {
      id,
      forceFlush: async () => {
        metricReaderForceFlushCalls++
        return Promise.resolve()
      },
      shutdown: async () => {
        metricReaderShutdownCalls++
        return Promise.resolve()
      },
    }
  }

  return {
    configureVariablesCalls,
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
    MockNodeSDK,
    nodeSdkInstances,
    reset() {
      configureVariablesCalls.length = 0
      evalForceFlushCalls = 0
      evalShutdownCalls = 0
      logForceFlushCalls = 0
      logShutdownCalls = 0
      metricReaderForceFlushCalls = 0
      metricReaderId = 0
      metricReaderShutdownCalls = 0
      shutdownVariablesCalls = 0
      shutdownPromises.length = 0
      traceForceFlushCalls = 0
      traceOnEndSpans.length = 0
      traceOnStartSpans.length = 0
      traceShutdownCalls = 0
      nodeSdkInstances.length = 0
    },
    queueShutdownPromise(promise: Promise<void>) {
      shutdownPromises.push(promise)
    },
    get shutdownVariablesCalls() {
      return shutdownVariablesCalls
    },
    shutdownVariables: async () => {
      shutdownVariablesCalls++
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
  }
})

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}))

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mocks.MockNodeSDK,
}))

vi.mock('logfire/evals', () => ({
  getEvalsSpanProcessor: () => mocks.evalProcessor,
}))

vi.mock('logfire/vars', () => ({
  configureVariables: (...args: unknown[]) => {
    mocks.configureVariablesCalls.push(args)
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

let processOnSpy: MockInstance<typeof process.on>
let processRemoveListenerSpy: MockInstance<typeof process.removeListener>
const originalOtelResourceAttributes = process.env['OTEL_RESOURCE_ATTRIBUTES']

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

describe('sdk lifecycle helpers', () => {
  beforeEach(() => {
    mocks.reset()
    delete process.env['OTEL_RESOURCE_ATTRIBUTES']
    Object.assign(logfireConfig, {
      additionalSpanProcessors: [],
      apiKey: undefined,
      codeSource: undefined,
      deploymentEnvironment: undefined,
      metrics: undefined,
      resourceAttributes: {},
      sampling: undefined,
      serviceName: undefined,
      serviceVersion: undefined,
      variables: undefined,
      variablesBaseUrl: undefined,
    })
    processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    processRemoveListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process)
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

    await forceFlush()

    expect(mocks.traceForceFlushCalls).toBe(1)
    expect(mocks.evalForceFlushCalls).toBe(1)
    expect(mocks.logForceFlushCalls).toBe(1)
    expect(mocks.metricReaderForceFlushCalls).toBe(1)
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
    expect(instance?.options.metricReaders).toContain(additionalMetricReader)

    await forceFlush()

    expect(mocks.metricReaderForceFlushCalls).toBe(1)
    expect(additionalMetricForceFlushCalls).toBe(1)

    await shutdown({ flush: false })

    expect(mocks.metricReaderShutdownCalls).toBe(1)
    expect(additionalMetricShutdownCalls).toBe(1)
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
    })
    start()

    resolvePreviousShutdown()
    await waitForBackgroundLifecycle()
    await forceFlush()

    expect(newRuntimeAdditionalForceFlushCalls).toBe(1)
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
    const listener = processOnSpy.mock.calls.find(([event]) => event === 'unhandledRejection')?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected unhandledRejection listener')
    }

    listener(new Error('boom'), Promise.resolve())
    await waitForBackgroundLifecycle()

    expect(additionalForceFlushCalls).toBe(1)
    expect(mocks.traceForceFlushCalls).toBe(1)
    expect(mocks.evalForceFlushCalls).toBe(1)
    expect(mocks.logForceFlushCalls).toBe(1)
    expect(mocks.metricReaderForceFlushCalls).toBe(1)
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
