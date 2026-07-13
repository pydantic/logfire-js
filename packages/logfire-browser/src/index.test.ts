/* eslint-disable import/first */
import type { Context, ContextManager } from '@opentelemetry/api'
import { context, diag, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => {
  const cleanupStepCalls: string[] = []
  const failures = new Map<string, unknown>()
  const browserMetricsRecorderCreateCalls: unknown[] = []
  const browserMetricsStartCalls: { options: unknown; resource: unknown }[] = []
  const browserMetricsRecorders: unknown[] = []
  const lifecycleEvents: string[] = []
  const autoInstrumentationConfigs: unknown[] = []
  const autoInstrumentations: unknown[] = []
  const registerInstrumentationCalls: { instrumentations: unknown; tracerProvider: unknown }[] = []
  const registrationFailures: unknown[] = []
  const webVitalsStartCalls: unknown[] = []
  const webTracerProviderInstances: MockWebTracerProvider[] = []
  let browserMetricsForceFlushCalls = 0
  let browserMetricsShutdownCalls = 0
  let browserMetricsStartupPromise:
    | Promise<{
        createWebVitalsMetricRecorder: (options: unknown) => unknown
        forceFlush: () => Promise<void>
        shutdown: () => Promise<void>
      }>
    | undefined
  let unregisterCalls = 0
  let webVitalsShutdownCalls = 0
  let webVitalsStartupPromise:
    | Promise<{
        shutdown: () => Promise<void>
      }>
    | undefined

  class MockWebTracerProvider {
    options: unknown
    forceFlushCalls = 0
    shutdownCalls = 0

    constructor(options: unknown) {
      this.options = options
      webTracerProviderInstances.push(this)
      lifecycleEvents.push('providerCreate')
    }

    getTracer(name: string) {
      return {
        name,
        provider: this,
        startSpan: () => {
          const attributes: Record<string, unknown> = {}
          const span = {
            attributes,
            end() {
              return undefined
            },
            isRecording() {
              return true
            },
            setAttribute(key: string, value: unknown) {
              attributes[key] = value
              return this
            },
            setAttributes(values: Record<string, unknown>) {
              Object.assign(attributes, values)
              return this
            },
          }
          const processors = (this.options as { spanProcessors: SpanProcessor[] }).spanProcessors
          for (const processor of processors) {
            processor.onStart(span as never, {} as never)
          }
          return span
        },
      }
    }

    async forceFlush(): Promise<void> {
      cleanupStepCalls.push('forceFlush')
      this.forceFlushCalls++
      if (failures.has('forceFlush')) {
        throw failures.get('forceFlush')
      }
      return Promise.resolve()
    }

    async shutdown(): Promise<void> {
      cleanupStepCalls.push('shutdown')
      this.shutdownCalls++
      if (failures.has('shutdown')) {
        throw failures.get('shutdown')
      }
      return Promise.resolve()
    }
  }

  function createWebVitalsHandle(): { shutdown: () => Promise<void> } {
    return {
      async shutdown() {
        cleanupStepCalls.push('webVitalsShutdown')
        webVitalsShutdownCalls++
        return Promise.resolve()
      },
    }
  }

  function createBrowserMetricsRuntime(): {
    createWebVitalsMetricRecorder: (options: unknown) => unknown
    forceFlush: () => Promise<void>
    shutdown: () => Promise<void>
  } {
    return {
      createWebVitalsMetricRecorder(options: unknown) {
        browserMetricsRecorderCreateCalls.push(options)
        const recorder = {
          record() {
            return undefined
          },
          shutdown() {
            return undefined
          },
        }
        browserMetricsRecorders.push(recorder)
        return recorder
      },
      async forceFlush() {
        cleanupStepCalls.push('metricForceFlush')
        browserMetricsForceFlushCalls++
        if (failures.has('metricForceFlush')) {
          throw failures.get('metricForceFlush')
        }
        return Promise.resolve()
      },
      async shutdown() {
        cleanupStepCalls.push('metricShutdown')
        browserMetricsShutdownCalls++
        if (failures.has('metricShutdown')) {
          throw failures.get('metricShutdown')
        }
        return Promise.resolve()
      },
    }
  }

  return {
    MockWebTracerProvider,
    browserMetricsRecorderCreateCalls,
    browserMetricsRecorders,
    autoInstrumentationConfigs,
    autoInstrumentations,
    browserMetricsStartCalls,
    cleanupStepCalls,
    createBrowserMetricsRuntime,
    createWebVitalsHandle,
    failStep(step: 'metricForceFlush' | 'metricShutdown' | 'unregister' | 'forceFlush' | 'shutdown', error: unknown) {
      failures.set(step, error)
    },
    failNextRegistration(error: unknown) {
      registrationFailures.push(error)
    },
    get browserMetricsForceFlushCalls() {
      return browserMetricsForceFlushCalls
    },
    get browserMetricsShutdownCalls() {
      return browserMetricsShutdownCalls
    },
    get lifecycleEvents() {
      return lifecycleEvents
    },
    get unregisterCalls() {
      return unregisterCalls
    },
    get webVitalsShutdownCalls() {
      return webVitalsShutdownCalls
    },
    get webVitalsStartCalls() {
      return webVitalsStartCalls
    },
    getWebAutoInstrumentations(config: unknown) {
      lifecycleEvents.push('getWebAutoInstrumentations')
      autoInstrumentationConfigs.push(config)
      const instrumentation = { name: 'auto-instrumentation', config }
      autoInstrumentations.push(instrumentation)
      return [instrumentation]
    },
    registerInstrumentationCalls,
    takeRegistrationFailure() {
      return registrationFailures.shift()
    },
    reset() {
      autoInstrumentationConfigs.length = 0
      autoInstrumentations.length = 0
      registerInstrumentationCalls.length = 0
      registrationFailures.length = 0
      browserMetricsForceFlushCalls = 0
      browserMetricsRecorderCreateCalls.length = 0
      browserMetricsRecorders.length = 0
      browserMetricsShutdownCalls = 0
      browserMetricsStartCalls.length = 0
      browserMetricsStartupPromise = undefined
      cleanupStepCalls.length = 0
      failures.clear()
      lifecycleEvents.length = 0
      unregisterCalls = 0
      webVitalsShutdownCalls = 0
      webVitalsStartCalls.length = 0
      webVitalsStartupPromise = undefined
      webTracerProviderInstances.length = 0
    },
    setBrowserMetricsStartupPromise(
      promise: Promise<{
        createWebVitalsMetricRecorder: (options: unknown) => unknown
        forceFlush: () => Promise<void>
        shutdown: () => Promise<void>
      }>
    ) {
      browserMetricsStartupPromise = promise
    },
    setWebVitalsStartupPromise(
      promise: Promise<{
        shutdown: () => Promise<void>
      }>
    ) {
      webVitalsStartupPromise = promise
    },
    unregister() {
      cleanupStepCalls.push('unregister')
      unregisterCalls++
      if (failures.has('unregister')) {
        throw failures.get('unregister')
      }
    },
    async startBrowserMetrics(options: unknown, resource: unknown) {
      lifecycleEvents.push('browserMetricsStart')
      browserMetricsStartCalls.push({ options, resource })
      return browserMetricsStartupPromise ?? Promise.resolve(createBrowserMetricsRuntime())
    },
    async startBrowserWebVitals(options: unknown) {
      lifecycleEvents.push('webVitalsStart')
      webVitalsStartCalls.push(options)
      return webVitalsStartupPromise ?? Promise.resolve(createWebVitalsHandle())
    },
    webTracerProviderInstances,
  }
})

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class MockOTLPTraceExporter {
    options: unknown

    constructor(options: unknown) {
      this.options = options
    }
  },
}))

vi.mock('@opentelemetry/instrumentation', () => ({
  registerInstrumentations: (options: { instrumentations: unknown; tracerProvider: unknown }) => {
    mocks.registerInstrumentationCalls.push(options)
    const failure = mocks.takeRegistrationFailure()
    if (failure !== undefined) {
      for (const instrumentation of options.instrumentations as { enable?: () => void }[]) {
        instrumentation.enable?.()
      }
      throw failure instanceof Error ? failure : new Error('mock instrumentation registration failed', { cause: failure })
    }
    return () => {
      mocks.unregister()
    }
  },
}))

vi.mock('@opentelemetry/auto-instrumentations-web', () => ({
  getWebAutoInstrumentations: (config: unknown) => mocks.getWebAutoInstrumentations(config),
}))

vi.mock('@opentelemetry/sdk-trace-web', () => ({
  BatchSpanProcessor: class MockBatchSpanProcessor {
    exporter: unknown
    config: unknown

    constructor(exporter: unknown, config: unknown) {
      this.exporter = exporter
      this.config = config
    }

    onStart(): void {
      return undefined
    }

    onEnd(): void {
      return undefined
    }
  },
  ParentBasedSampler: class MockParentBasedSampler {
    config: unknown

    constructor(config: unknown) {
      this.config = config
    }
  },
  StackContextManager: class MockStackContextManager {
    readonly name = 'mock-stack-context-manager'

    active() {
      return ROOT_CONTEXT
    }

    bind<T>(_context: unknown, target: T): T {
      return target
    }

    disable(): this {
      return this
    }

    enable(): this {
      return this
    }

    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      _context: unknown,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> {
      return Reflect.apply(fn, thisArg, args)
    }
  },
  TraceIdRatioBasedSampler: class MockTraceIdRatioBasedSampler {
    ratio: number

    constructor(ratio: number) {
      this.ratio = ratio
    }
  },
  WebTracerProvider: mocks.MockWebTracerProvider,
}))

vi.mock('./webVitals', () => ({
  startBrowserWebVitals: async (options: unknown) => mocks.startBrowserWebVitals(options),
}))

vi.mock('./browserMetrics', () => ({
  startBrowserMetrics: async (options: unknown, resource: unknown) => mocks.startBrowserMetrics(options, resource),
}))

import { configureLogfireApi, Level, logfireApiConfig, PendingSpanProcessor, TailSamplingProcessor } from 'logfire'

import { BrowserSessionSpanProcessor } from './BrowserSessionSpanProcessor'
import { clearConfiguredBrowserSessionForTests } from './browserSession'
import logfireBrowser, { configure, getBrowserSessionId, instrument, startPendingSpan, startSpan, withSettings, withTags } from './index'
import { ACTIVE_CONFIGURATION_ERROR, FAILED_CLEANUP_ERROR, resetProviderLifecycleForTests } from './providerLifecycle'
import type { BrowserSessionReplayRuntime } from './sessionReplay'

afterEach(() => {
  resetProviderLifecycleForTests()
})

const originalNavigator = globalThis.navigator
const originalLocation = globalThis.location
let cleanup: (() => Promise<void>) | undefined
type CleanupStep = 'unregister' | 'forceFlush' | 'shutdown'

function getLatestResourceAttributes(): Record<string, unknown> {
  const instance = mocks.webTracerProviderInstances[mocks.webTracerProviderInstances.length - 1]
  expect(instance).toBeDefined()
  if (instance === undefined) {
    throw new Error('expected WebTracerProvider mock instance')
  }
  return (instance.options as { resource: { attributes: Record<string, unknown> } }).resource.attributes
}

function getLatestWebTracerProvider() {
  const instance = mocks.webTracerProviderInstances[mocks.webTracerProviderInstances.length - 1]
  expect(instance).toBeDefined()
  if (instance === undefined) {
    throw new Error('expected WebTracerProvider mock instance')
  }
  return instance
}

function getLatestSpanProcessors(): unknown[] {
  const provider = getLatestWebTracerProvider()
  return (provider.options as { spanProcessors: unknown[] }).spanProcessors
}

function noopSpanProcessorCallback(): void {
  return undefined
}

function createTestSpanProcessor(): SpanProcessor {
  return {
    forceFlush: async () => Promise.resolve(),
    onEnd: noopSpanProcessorCallback,
    onStart: noopSpanProcessorCallback,
    shutdown: async () => Promise.resolve(),
  }
}

async function waitForConfigureMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function expectCleanupFailureIsMemoized(failingStep: CleanupStep) {
  const error = new Error(`${failingStep} failed`)
  mocks.failStep(failingStep, error)
  cleanup = configure({
    traceUrl: 'http://localhost:8989/client-traces',
  })

  const firstCleanup = cleanup()
  await expect(firstCleanup).rejects.toThrow(error.message)
  const cleanupError = await firstCleanup.catch((rejection: unknown) => rejection)
  expect(cleanupError).toBeInstanceOf(Error)
  expect((cleanupError as Error).cause).toBe(error)
  expect(cleanup()).toBe(firstCleanup)
  await expect(cleanup()).rejects.toThrow(error.message)

  const tracerProvider = getLatestWebTracerProvider()
  expect(mocks.unregisterCalls).toBe(1)
  expect(tracerProvider.forceFlushCalls).toBe(1)
  expect(tracerProvider.shutdownCalls).toBe(1)
  expect(mocks.cleanupStepCalls).toEqual(['unregister', 'forceFlush', 'shutdown'])
  expect(() => {
    configure({ traceUrl: 'http://localhost:8989/retry-traces' })
  }).toThrow(FAILED_CLEANUP_ERROR)

  cleanup = undefined
}

describe('browser configure resource attributes', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    vi.restoreAllMocks()
  })

  it('adds configured resource attributes to the WebTracerProvider resource', () => {
    cleanup = configure({
      resourceAttributes: {
        'app.installation.id': 'install-123',
        'service.namespace': 'my-company',
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(getLatestResourceAttributes()).toMatchObject({
      'app.installation.id': 'install-123',
      'browser.language': 'en-US',
      'service.name': 'logfire-browser',
      'service.namespace': 'my-company',
      'service.version': '0.0.1',
      'telemetry.sdk.name': 'logfire-browser',
    })
  })

  it('keeps browser defaults ahead of generic resource attributes', () => {
    cleanup = configure({
      resourceAttributes: {
        'service.name': 'generic-service',
        'service.version': '0.0.1',
        'telemetry.sdk.name': 'custom-sdk',
      },
      serviceName: 'configured-service',
      serviceVersion: '1.2.3',
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(getLatestResourceAttributes()).toMatchObject({
      'service.name': 'configured-service',
      'service.version': '1.2.3',
      'telemetry.sdk.name': 'logfire-browser',
    })
  })

  it('passes baggage span attributes config to the shared API', () => {
    cleanup = configure({
      baggage: {
        spanAttributes: ['tenant'],
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(logfireApiConfig.baggage).toEqual({ spanAttributes: ['tenant'] })
  })

  it('passes minLevel config to the shared API', () => {
    cleanup = configure({
      minLevel: 'warning',
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(logfireApiConfig.minLevel).toBe(Level.Warning)
  })

  it('passes jsonSchema config to the shared API', () => {
    cleanup = configure({
      jsonSchema: 'basic',
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(logfireApiConfig.jsonSchema).toBe('basic')
  })
})

describe('browser pending spans', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    vi.restoreAllMocks()
  })

  it('does not install automatic pending spans in the default processor pipeline', () => {
    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors.some((processor) => processor instanceof PendingSpanProcessor)).toBe(false)
  })

  it('does not install automatic pending spans in the head-sampled processor pipeline', () => {
    cleanup = configure({
      sampling: { head: 0.5 },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors.some((processor) => processor instanceof PendingSpanProcessor)).toBe(false)
  })

  it('does not install automatic or deferred pending spans in the tail-sampled processor pipeline', () => {
    cleanup = configure({
      sampling: { tail: () => 0.0 },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors.some((processor) => processor instanceof PendingSpanProcessor)).toBe(false)
    expect(spanProcessors[0]).toBeInstanceOf(TailSamplingProcessor)
    expect((spanProcessors[0] as { deferredProcessor?: unknown }).deferredProcessor).toBeUndefined()
  })

  it('re-exports startPendingSpan from the shared API', () => {
    expect(typeof startPendingSpan).toBe('function')
    expect(logfireBrowser.startPendingSpan).toBe(startPendingSpan)
  })

  it('re-exports getBrowserSessionId from the browser session API', () => {
    expect(typeof getBrowserSessionId).toBe('function')
  })

  it('re-exports instrument from the shared API', () => {
    expect(logfireBrowser.instrument).toBe(instrument)
  })

  it('re-exports scoped client helpers from the shared API', () => {
    expect(logfireBrowser.withSettings).toBe(withSettings)
    expect(logfireBrowser.withTags).toBe(withTags)
  })
})

describe('browser span processors', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    vi.restoreAllMocks()
  })

  it('passes custom span processors before the built-in Logfire processor', () => {
    const customProcessor = createTestSpanProcessor()
    cleanup = configure({
      spanProcessors: [customProcessor],
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBe(customProcessor)
    expect(spanProcessors).toHaveLength(2)
  })

  it('routes a cached global tracer and manual tracer through A, inactive, and B', async () => {
    const cachedGlobalTracer = trace.getTracer('cached-public-configure')
    const aStarts = vi.fn<SpanProcessor['onStart']>()
    const bStarts = vi.fn<SpanProcessor['onStart']>()
    const aProcessor = { ...createTestSpanProcessor(), onStart: aStarts }
    const bProcessor = { ...createTestSpanProcessor(), onStart: bStarts }

    const cleanupA = configure({
      resourceAttributes: { generation: 'A' },
      rum: { webVitals: true },
      spanProcessors: [aProcessor],
      traceUrl: 'http://localhost:8989/traces-a',
    })
    cachedGlobalTracer.startSpan('cached-a').end()
    startSpan('manual-a').end()
    const webVitalsTracerA = (mocks.webVitalsStartCalls[0] as { tracer: { startSpan: (name: string) => { end: () => void } } }).tracer
    webVitalsTracerA.startSpan('web-vital-a').end()
    await cleanupA()

    expect(cachedGlobalTracer.startSpan('inactive').isRecording()).toBe(false)
    expect(startSpan('manual-inactive').isRecording()).toBe(false)

    cleanup = configure({
      resourceAttributes: { generation: 'B' },
      rum: { webVitals: true },
      spanProcessors: [bProcessor],
      traceUrl: 'http://localhost:8989/traces-b',
    })
    cachedGlobalTracer.startSpan('cached-b').end()
    startSpan('manual-b').end()
    const webVitalsTracerB = (mocks.webVitalsStartCalls[1] as { tracer: { startSpan: (name: string) => { end: () => void } } }).tracer
    webVitalsTracerB.startSpan('web-vital-b').end()

    expect(aStarts).toHaveBeenCalledTimes(3)
    expect(bStarts).toHaveBeenCalledTimes(3)
    expect(mocks.webVitalsStartCalls).toHaveLength(2)
    expect(getLatestResourceAttributes()['generation']).toBe('B')
  })

  it('rejects active and cleaning overlap without creating a second provider', async () => {
    let releaseWebVitals!: (handle: { shutdown: () => Promise<void> }) => void
    mocks.setWebVitalsStartupPromise(
      new Promise((resolve) => {
        releaseWebVitals = resolve
      })
    )
    const cleanupA = configure({
      rum: { webVitals: true },
      traceUrl: 'http://localhost:8989/traces-a',
    })

    expect(() => {
      configure({ traceUrl: 'http://localhost:8989/active-overlap' })
    }).toThrow(ACTIVE_CONFIGURATION_ERROR)
    expect(mocks.webTracerProviderInstances).toHaveLength(1)

    const pendingCleanup = cleanupA()
    expect(() => {
      configure({ traceUrl: 'http://localhost:8989/cleaning-overlap' })
    }).toThrow(ACTIVE_CONFIGURATION_ERROR)
    expect(mocks.webTracerProviderInstances).toHaveLength(1)

    releaseWebVitals({ shutdown: async () => Promise.resolve() })
    await pendingCleanup
    cleanup = configure({ traceUrl: 'http://localhost:8989/traces-b' })
    expect(mocks.webTracerProviderInstances).toHaveLength(2)
  })

  it('leaves shared API settings unchanged when external context rejects an explicit manager', () => {
    const applicationManager = createMockContextManager()
    const candidate = createMockContextManager()
    const candidateEnable = vi.spyOn(candidate, 'enable')
    const candidateDisable = vi.spyOn(candidate, 'disable')
    expect(context.setGlobalContextManager(applicationManager)).toBe(true)
    applicationManager.enable()
    configureLogfireApi({ baggage: { spanAttributes: ['existing'] }, minLevel: 'warning' })
    const originalScrubber = logfireApiConfig.scrubber
    const originalMinLevel = logfireApiConfig.minLevel

    expect(() => {
      configure({
        baggage: { spanAttributes: ['replacement'] },
        contextManager: candidate,
        minLevel: 'fatal',
        scrubbing: false,
        traceUrl: 'http://localhost:8989/rejected-context',
      })
    }).toThrow('omit contextManager')

    expect(candidateEnable).not.toHaveBeenCalled()
    expect(candidateDisable).not.toHaveBeenCalled()
    expect(logfireApiConfig.baggage.spanAttributes).toEqual(['existing'])
    expect(logfireApiConfig.minLevel).toBe(originalMinLevel)
    expect(logfireApiConfig.scrubber).toBe(originalScrubber)
    expect(mocks.webTracerProviderInstances).toHaveLength(0)
  })

  it('restores shared settings and settles provider/session rollback before permitting retry', async () => {
    configureLogfireApi({ baggage: { spanAttributes: ['existing'] }, jsonSchema: 'basic', minLevel: 'warning' })
    const sharedApiConfigBefore = {
      baggage: logfireApiConfig.baggage,
      enableErrorFingerprinting: logfireApiConfig.enableErrorFingerprinting,
      jsonSchema: logfireApiConfig.jsonSchema,
      minLevel: logfireApiConfig.minLevel,
      scrubber: logfireApiConfig.scrubber,
      tracer: logfireApiConfig.tracer,
    }
    expect(() => {
      configure({
        baggage: { spanAttributes: ['replacement'] },
        jsonSchema: false,
        minLevel: 'fatal',
        rum: { session: true },
        scrubbing: { extraPatterns: ['['] },
        traceUrl: 'http://localhost:8989/invalid-scrubbing',
      })
    }).toThrow('Invalid regular expression')

    expect(mocks.webTracerProviderInstances).toHaveLength(1)
    expect(mocks.webTracerProviderInstances[0]?.shutdownCalls).toBe(1)
    expect(getBrowserSessionId()).toBeUndefined()
    expect(logfireApiConfig).toMatchObject(sharedApiConfigBefore)
    expect(() => {
      configure({ traceUrl: 'http://localhost:8989/retry-before-rollback-settles' })
    }).toThrow(ACTIVE_CONFIGURATION_ERROR)

    await waitForConfigureMicrotasks()
    cleanup = configure({ traceUrl: 'http://localhost:8989/retry-after-rollback' })
    expect(mocks.webTracerProviderInstances).toHaveLength(2)
  })

  it('makes failed synchronous setup rollback terminal when provider shutdown rejects', async () => {
    mocks.failStep('shutdown', new Error('setup rollback shutdown failed'))
    expect(() => {
      configure({
        scrubbing: { extraPatterns: ['['] },
        traceUrl: 'http://localhost:8989/failed-setup-rollback',
      })
    }).toThrow('Invalid regular expression')

    await waitForConfigureMicrotasks()
    expect(() => {
      configure({ traceUrl: 'http://localhost:8989/retry-after-failed-setup-rollback' })
    }).toThrow(FAILED_CLEANUP_ERROR)
  })

  it('keeps tail sampling scoped to the built-in Logfire processor', () => {
    const customProcessor = createTestSpanProcessor()
    cleanup = configure({
      sampling: { tail: () => 0.0 },
      spanProcessors: [customProcessor],
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBe(customProcessor)
    expect(spanProcessors[1]).toBeInstanceOf(TailSamplingProcessor)
  })

  it('does not install the browser session processor by default', () => {
    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors.some((processor) => processor instanceof BrowserSessionSpanProcessor)).toBe(false)
  })

  it('does not install the browser session processor when rum.session is false', () => {
    cleanup = configure({
      rum: { session: false },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors.some((processor) => processor instanceof BrowserSessionSpanProcessor)).toBe(false)
  })

  it('installs the browser session processor before custom processors', () => {
    const customProcessor = createTestSpanProcessor()
    cleanup = configure({
      rum: { session: true },
      spanProcessors: [customProcessor],
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBeInstanceOf(BrowserSessionSpanProcessor)
    expect(spanProcessors[1]).toBe(customProcessor)
    expect(spanProcessors).toHaveLength(3)
  })

  it('exports stable page URL attributes through public configure and tracing boundaries', async () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: 'https://example.com/dashboard?token=secret#recent' },
    })

    const exercise = async (session: NonNullable<NonNullable<Parameters<typeof configure>[0]['rum']>['session']>) => {
      let observed: Record<string, unknown> | undefined
      const observer = createTestSpanProcessor()
      observer.onStart = (span) => {
        observed = { ...(span as unknown as { attributes: Record<string, unknown> }).attributes }
      }
      cleanup = configure({
        rum: { session },
        spanProcessors: [observer],
        traceUrl: 'http://localhost:8989/client-traces',
      })
      trace.getTracer('public-consumer').startSpan('page view').end()
      await cleanup()
      cleanup = undefined
      clearConfiguredBrowserSessionForTests()
      return observed
    }

    try {
      const defaultAttributes = await exercise(true)
      expect(defaultAttributes).toMatchObject({
        'logfire.page.url.full': 'https://example.com/dashboard',
        'logfire.page.url.path': '/dashboard',
      })
      expect(defaultAttributes).not.toHaveProperty('url.full')
      expect(defaultAttributes).not.toHaveProperty('url.path')

      const rawAttributes = await exercise({
        urlAttributes: (url) => ({ full: url.href, path: url.pathname }),
      })
      expect(rawAttributes).toMatchObject({
        'logfire.page.url.full': 'https://example.com/dashboard?token=secret#recent',
        'logfire.page.url.path': '/dashboard',
      })

      const sanitizedAttributes = await exercise({
        urlAttributes: (url) => ({ full: `${url.origin}${url.pathname}`, path: '/custom-page' }),
      })
      expect(sanitizedAttributes).toMatchObject({
        'logfire.page.url.full': 'https://example.com/dashboard',
        'logfire.page.url.path': '/custom-page',
      })

      const disabledAttributes = await exercise({ urlAttributes: false })
      expect(disabledAttributes).not.toHaveProperty('logfire.page.url.full')
      expect(disabledAttributes).not.toHaveProperty('logfire.page.url.path')
    } finally {
      if (locationDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'location')
      } else {
        Object.defineProperty(globalThis, 'location', locationDescriptor)
      }
    }
  })

  it('lazily creates a configured browser session id before the first span', () => {
    cleanup = configure({
      rum: { session: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(getBrowserSessionId()).toEqual(expect.any(String))
  })

  it('resolves instrumentation factories after provider registration', () => {
    const preconstructedInstrumentation = { name: 'preconstructed' } as unknown as Instrumentation
    const factoryInstrumentation = { name: 'factory' } as unknown as Instrumentation
    const factory = vi.fn<() => Instrumentation[]>(() => {
      mocks.lifecycleEvents.push('instrumentationFactory')
      return [factoryInstrumentation]
    })

    cleanup = configure({
      instrumentations: [preconstructedInstrumentation, factory],
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(mocks.lifecycleEvents).toEqual(['providerCreate', 'instrumentationFactory'])
    expect(mocks.registerInstrumentationCalls[0]).toMatchObject({
      instrumentations: [preconstructedInstrumentation],
      tracerProvider: getLatestWebTracerProvider(),
    })
    expect(mocks.registerInstrumentationCalls[1]).toMatchObject({
      instrumentations: [factoryInstrumentation],
      tracerProvider: getLatestWebTracerProvider(),
    })
  })

  it('contains a throwing instrumentation factory and continues with later groups', async () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    const goodInstrumentation = { name: 'good' } as unknown as Instrumentation
    const factoryError = new Error('factory failed')
    const coreSpanStart = vi.fn<SpanProcessor['onStart']>()
    const observer = { ...createTestSpanProcessor(), onStart: coreSpanStart }

    cleanup = configure({
      instrumentations: [
        () => {
          throw factoryError
        },
        goodInstrumentation,
      ],
      spanProcessors: [observer],
      traceUrl: 'http://localhost:8989/client-traces',
    })
    trace.getTracer('consumer-after-factory-failure').startSpan('still works').end()

    expect(mocks.registerInstrumentationCalls.at(-1)).toMatchObject({ instrumentations: [goodInstrumentation] })
    expect(coreSpanStart).toHaveBeenCalledTimes(1)
    expect(diagError).toHaveBeenCalledWith('logfire-browser: failed to start configured browser instrumentation group', factoryError)
    await expect(cleanup()).resolves.toBeUndefined()
    cleanup = undefined
  })

  it('disables a group whose registration throws and keeps later groups configured', async () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    const registrationError = new Error('registration failed')
    const enable = vi.fn<() => void>()
    const disable = vi.fn<() => void>()
    const failedInstrumentation = { disable, enable, name: 'failed' } as unknown as Instrumentation
    const goodInstrumentation = { name: 'good' } as unknown as Instrumentation
    const coreSpanStart = vi.fn<SpanProcessor['onStart']>()
    const observer = { ...createTestSpanProcessor(), onStart: coreSpanStart }
    mocks.failNextRegistration(registrationError)

    cleanup = configure({
      instrumentations: [failedInstrumentation, goodInstrumentation],
      spanProcessors: [observer],
      traceUrl: 'http://localhost:8989/client-traces',
    })
    trace.getTracer('consumer-after-registration-failure').startSpan('still works').end()

    expect(enable).toHaveBeenCalledTimes(1)
    expect(disable).toHaveBeenCalledTimes(1)
    expect(mocks.registerInstrumentationCalls.at(-1)).toMatchObject({ instrumentations: [goodInstrumentation] })
    expect(coreSpanStart).toHaveBeenCalledTimes(1)
    expect(diagError).toHaveBeenCalledWith('logfire-browser: failed to start configured browser instrumentation group', registrationError)
    await expect(cleanup()).resolves.toBeUndefined()
    cleanup = undefined
  })

  it('lazily loads first-class browser auto-instrumentations after provider registration', async () => {
    cleanup = configure({
      autoInstrumentations: {
        '@opentelemetry/instrumentation-fetch': { enabled: true },
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(mocks.lifecycleEvents).toEqual(['providerCreate'])
    expect(mocks.autoInstrumentationConfigs).toEqual([])

    await waitForConfigureMicrotasks()

    expect(mocks.lifecycleEvents).toEqual(['providerCreate', 'getWebAutoInstrumentations'])
    expect(mocks.autoInstrumentationConfigs).toHaveLength(1)
    const autoConfig = mocks.autoInstrumentationConfigs[0] as Record<string, { enabled?: boolean; ignoreUrls?: (string | RegExp)[] }>
    expect(autoConfig['@opentelemetry/instrumentation-fetch']?.enabled).toBe(true)
    expect(
      autoConfig['@opentelemetry/instrumentation-fetch']?.ignoreUrls?.some(
        (url) => url instanceof RegExp && url.test('http://localhost:8989/client-traces')
      )
    ).toBe(true)
    expect(
      autoConfig['@opentelemetry/instrumentation-xml-http-request']?.ignoreUrls?.some(
        (url) => url instanceof RegExp && url.test('http://localhost:8989/client-traces')
      )
    ).toBe(true)
    expect(mocks.registerInstrumentationCalls[1]).toMatchObject({
      instrumentations: mocks.autoInstrumentations,
      tracerProvider: getLatestWebTracerProvider(),
    })
  })

  it('merges every SDK endpoint into fetch and XHR ignores without mutating caller config', async () => {
    const fetchIgnores = [/consumer-fetch/u]
    const xhrIgnores = ['https://app.example/consumer-xhr']
    const autoInstrumentations = {
      '@opentelemetry/instrumentation-fetch': { enabled: false, ignoreUrls: fetchIgnores },
      '@opentelemetry/instrumentation-xml-http-request': { ignoreUrls: xhrIgnores },
    }
    const originalFetchConfig = autoInstrumentations['@opentelemetry/instrumentation-fetch']
    const originalXhrConfig = autoInstrumentations['@opentelemetry/instrumentation-xml-http-request']

    cleanup = configure({
      autoInstrumentations,
      metrics: { metricUrl: '/client-metrics' },
      sessionReplay: {
        load: () => ({
          startSessionReplay: () => ({
            mode: 'full',
            recording: true,
            flush: async () => Promise.resolve(),
            getSessionId: () => 'browser-session',
            stop: async () => Promise.resolve(),
          }),
        }),
        replayUrl: '/client-replay',
      },
      traceUrl: '/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(autoInstrumentations['@opentelemetry/instrumentation-fetch']).toBe(originalFetchConfig)
    expect(autoInstrumentations['@opentelemetry/instrumentation-xml-http-request']).toBe(originalXhrConfig)
    expect(originalFetchConfig).toEqual({ enabled: false, ignoreUrls: fetchIgnores })
    expect(originalXhrConfig).toEqual({ ignoreUrls: xhrIgnores })

    const merged = mocks.autoInstrumentationConfigs.at(-1) as Record<string, { enabled?: boolean; ignoreUrls?: (string | RegExp)[] }>
    const mergedFetch = merged['@opentelemetry/instrumentation-fetch']
    const mergedXhr = merged['@opentelemetry/instrumentation-xml-http-request']
    expect(mergedFetch?.enabled).toBe(false)
    expect(mergedFetch?.ignoreUrls?.[0]).toBe(fetchIgnores[0])
    expect(mergedXhr?.ignoreUrls?.[0]).toBe(xhrIgnores[0])
    for (const endpoint of ['/client-traces', '/client-metrics', '/client-replay/session-1?seq=0']) {
      expect(mergedFetch?.ignoreUrls?.some((url) => url instanceof RegExp && url.test(endpoint))).toBe(true)
      expect(mergedXhr?.ignoreUrls?.some((url) => url instanceof RegExp && url.test(endpoint))).toBe(true)
    }
    for (const applicationUrl of ['/client-traces/users', '/client-metrics/daily', '/client-replay-other/session-1']) {
      expect(mergedFetch?.ignoreUrls?.some((url) => url instanceof RegExp && url.test(applicationUrl))).toBe(false)
      expect(mergedXhr?.ignoreUrls?.some((url) => url instanceof RegExp && url.test(applicationUrl))).toBe(false)
    }
  })

  it('merges absolute trace, metric, and replay endpoints into fetch and XHR ignores', async () => {
    cleanup = configure({
      autoInstrumentations: true,
      metrics: { metricUrl: 'https://telemetry.example/v1/metrics' },
      sessionReplay: {
        load: () => ({
          startSessionReplay: () => ({
            mode: 'full',
            recording: true,
            flush: async () => Promise.resolve(),
            getSessionId: () => 'browser-session',
            stop: async () => Promise.resolve(),
          }),
        }),
        replayUrl: 'https://telemetry.example/v1/replay',
      },
      traceUrl: 'https://telemetry.example/v1/traces',
    })
    await waitForConfigureMicrotasks()

    const merged = mocks.autoInstrumentationConfigs.at(-1) as Record<string, { ignoreUrls?: RegExp[] }>
    for (const key of ['@opentelemetry/instrumentation-fetch', '@opentelemetry/instrumentation-xml-http-request']) {
      const ignoreUrls = merged[key]?.ignoreUrls ?? []
      for (const endpoint of [
        'https://telemetry.example/v1/traces',
        'https://telemetry.example/v1/metrics',
        'https://telemetry.example/v1/replay/session-1?seq=0',
      ]) {
        expect(ignoreUrls.some((pattern) => pattern.test(endpoint))).toBe(true)
      }
    }
  })

  it('rejects invalid replay URLs during configuration before installing instrumentation', () => {
    const originalLocation = Reflect.get(globalThis, 'location') as unknown
    const originalDocument = Reflect.get(globalThis, 'document') as unknown
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: new URL('https://app.example/nested/page/'),
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { baseURI: 'https://app.example/' },
    })
    const load = vi.fn<() => { startSessionReplay: () => BrowserSessionReplayRuntime }>()
    const configCount = mocks.autoInstrumentationConfigs.length

    try {
      expect(() =>
        configure({
          autoInstrumentations: true,
          sessionReplay: { load, replayUrl: '/' },
          traceUrl: '/client-traces',
        })
      ).toThrow(/must use a non-root path/u)

      expect(load).not.toHaveBeenCalled()
      expect(mocks.autoInstrumentationConfigs).toHaveLength(configCount)
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation })
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }
  })

  it('does not load first-class browser auto-instrumentations when disabled', async () => {
    cleanup = configure({
      autoInstrumentations: { enabled: false },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(mocks.autoInstrumentationConfigs).toEqual([])
    expect(mocks.registerInstrumentationCalls).toHaveLength(1)
  })
})

describe('browser Web Vitals config', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    vi.restoreAllMocks()
  })

  it('does not start Web Vitals by default', () => {
    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(mocks.webVitalsStartCalls).toEqual([])
  })

  it('does not start Web Vitals when rum.webVitals is false', () => {
    cleanup = configure({
      rum: { webVitals: false },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(mocks.webVitalsStartCalls).toEqual([])
  })

  it('starts Web Vitals after tracer provider registration when enabled', () => {
    cleanup = configure({
      rum: { webVitals: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(mocks.webVitalsStartCalls).toHaveLength(1)
    expect(mocks.webVitalsStartCalls[0]).toMatchObject({ tracer: { name: 'logfire-web-vitals' } })
    expect(mocks.lifecycleEvents).toEqual(['providerCreate', 'webVitalsStart'])
  })

  it('passes Web Vitals options through to startup', () => {
    const generateTarget = () => 'target'
    cleanup = configure({
      rum: {
        webVitals: {
          generateTarget,
          includeProcessedEventEntries: true,
          reportAllChanges: true,
        },
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(mocks.webVitalsStartCalls).toHaveLength(1)
    expect(mocks.webVitalsStartCalls[0]).toMatchObject({
      generateTarget,
      includeProcessedEventEntries: true,
      reportAllChanges: true,
      tracer: { name: 'logfire-web-vitals' },
    })
  })

  it('retries Web Vitals through configure after a transient startup failure', async () => {
    const startupError = new Error('transient Web Vitals import failure')
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    mocks.setWebVitalsStartupPromise(Promise.reject(startupError))
    cleanup = configure({
      rum: { webVitals: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()
    await cleanup()
    cleanup = undefined

    mocks.setWebVitalsStartupPromise(Promise.resolve(mocks.createWebVitalsHandle()))
    cleanup = configure({
      rum: { webVitals: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(mocks.webVitalsStartCalls).toHaveLength(2)
    expect(diagError).toHaveBeenCalledWith('logfire-browser: failed to start Web Vitals reporting', startupError)
  })

  it('implies browser session attributes when Web Vitals are enabled', () => {
    cleanup = configure({
      rum: { webVitals: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBeInstanceOf(BrowserSessionSpanProcessor)
  })

  it('rejects Web Vitals when session attributes are explicitly disabled', () => {
    expect(() => {
      configure({
        rum: { session: false, webVitals: true },
        traceUrl: 'http://localhost:8989/client-traces',
      })
    }).toThrow('rum.webVitals requires browser session attributes')
    expect(mocks.webVitalsStartCalls).toEqual([])
  })

  it('waits for Web Vitals startup and shutdown during cleanup', async () => {
    let resolveStartup: ((handle: { shutdown: () => Promise<void> }) => void) | undefined
    mocks.setWebVitalsStartupPromise(
      new Promise((resolve) => {
        resolveStartup = resolve
      })
    )
    cleanup = configure({
      rum: { webVitals: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const cleanupPromise = cleanup()
    await Promise.resolve()

    expect(mocks.cleanupStepCalls).toEqual(['unregister'])
    expect(mocks.webVitalsShutdownCalls).toBe(0)

    resolveStartup?.(mocks.createWebVitalsHandle())
    await cleanupPromise

    expect(mocks.webVitalsShutdownCalls).toBe(1)
    expect(mocks.cleanupStepCalls).toEqual(['unregister', 'webVitalsShutdown', 'forceFlush', 'shutdown'])
    expect(cleanup()).toBe(cleanupPromise)
  })
})

describe('browser session replay config', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    vi.restoreAllMocks()
  })

  it('does not load replay by default or when disabled', async () => {
    const load = vi.fn<() => void>()

    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()
    expect(load).not.toHaveBeenCalled()
    await cleanup()

    cleanup = configure({
      sessionReplay: false,
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()
    expect(load).not.toHaveBeenCalled()
  })

  it('starts replay after provider registration and implies browser session attributes', async () => {
    const startSessionReplay = vi.fn<() => BrowserSessionReplayRuntime>(() => ({
      mode: 'full' as const,
      recording: true,
      flush: async () => Promise.resolve(),
      getSessionId: () => 'browser-session',
      stop: async () => Promise.resolve(),
    }))
    const load = vi.fn<() => { startSessionReplay: () => BrowserSessionReplayRuntime }>(() => {
      mocks.lifecycleEvents.push('sessionReplayLoad')
      return { startSessionReplay }
    })

    cleanup = configure({
      sessionReplay: {
        load,
        replayUrl: '/logfire/replay',
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(load).toHaveBeenCalledTimes(1)
    expect(startSessionReplay).toHaveBeenCalledTimes(1)
    expect(mocks.lifecycleEvents).toEqual(['providerCreate', 'sessionReplayLoad'])
    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBeInstanceOf(BrowserSessionSpanProcessor)
  })

  it('rejects replay when session attributes are explicitly disabled', () => {
    expect(() => {
      configure({
        rum: { session: false },
        sessionReplay: {
          load: () => ({ startSessionReplay: vi.fn<() => BrowserSessionReplayRuntime>() }),
          replayUrl: '/logfire/replay',
        },
        traceUrl: 'http://localhost:8989/client-traces',
      })
    }).toThrow('sessionReplay requires browser session attributes')
  })

  it('keeps tracing setup alive when replay startup fails', async () => {
    const onError = vi.fn<(error: unknown) => void>()

    cleanup = configure({
      sessionReplay: {
        load: async () => Promise.reject(new Error('missing replay package')),
        onError,
        replayUrl: '/logfire/replay',
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(getLatestWebTracerProvider().shutdownCalls).toBe(0)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('stops replay before unregister and exporter shutdown during cleanup', async () => {
    const stop = vi.fn<() => Promise<void>>(async () => {
      mocks.cleanupStepCalls.push('sessionReplayStop')
      return Promise.resolve()
    })

    cleanup = configure({
      metrics: { metricUrl: 'http://localhost:8989/client-metrics' },
      sessionReplay: {
        load: () => ({
          startSessionReplay: () => ({
            mode: 'full',
            recording: true,
            flush: async () => Promise.resolve(),
            getSessionId: () => 'browser-session',
            stop,
          }),
        }),
        replayUrl: '/logfire/replay',
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    const cleanupPromise = cleanup()
    await cleanupPromise

    expect(cleanup()).toBe(cleanupPromise)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(mocks.cleanupStepCalls).toEqual([
      'sessionReplayStop',
      'unregister',
      'metricForceFlush',
      'metricShutdown',
      'forceFlush',
      'shutdown',
    ])
  })
})

describe('browser metrics config', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: originalLocation,
    })
    vi.restoreAllMocks()
  })

  it('does not start browser metrics by default', async () => {
    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(mocks.browserMetricsStartCalls).toEqual([])
  })

  it('does not start browser metrics when metrics is false', async () => {
    cleanup = configure({
      metrics: false,
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(mocks.browserMetricsStartCalls).toEqual([])
  })

  it('starts browser metrics after tracer provider registration when configured', async () => {
    const metricExporterHeaders = () => ({ authorization: 'test-token' })
    const metricReader = { forceFlush: async () => Promise.resolve(), shutdown: async () => Promise.resolve() }

    cleanup = configure({
      metrics: {
        metricExporterConfig: { timeoutMillis: 12_000 },
        metricExporterHeaders,
        metricReaderConfig: { exportIntervalMillis: 5_000 },
        metricReaders: [metricReader as never],
        metricUrl: 'http://localhost:8989/client-metrics',
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(mocks.browserMetricsStartCalls).toHaveLength(1)
    expect(mocks.browserMetricsStartCalls[0]?.options).toMatchObject({
      metricExporterConfig: { timeoutMillis: 12_000 },
      metricReaderConfig: { exportIntervalMillis: 5_000 },
      metricUrl: 'http://localhost:8989/client-metrics',
    })
    expect((mocks.browserMetricsStartCalls[0]?.options as { metricExporterHeaders?: unknown }).metricExporterHeaders).toBe(
      metricExporterHeaders
    )
    expect((mocks.browserMetricsStartCalls[0]?.options as { metricReaders?: unknown[] }).metricReaders).toEqual([metricReader])
    expect(mocks.lifecycleEvents).toEqual(['providerCreate', 'browserMetricsStart'])
  })

  it('rejects empty metric URLs', () => {
    expect(() => {
      configure({
        metrics: { metricUrl: '' },
        traceUrl: 'http://localhost:8989/client-traces',
      })
    }).toThrow('metrics.metricUrl must be a non-empty')
  })

  it('rejects Web Vitals metrics without browser metric transport', () => {
    expect(() => {
      configure({
        rum: { webVitals: { metrics: true } },
        traceUrl: 'http://localhost:8989/client-traces',
      })
    }).toThrow('rum.webVitals.metrics requires top-level metrics.metricUrl')
    expect(mocks.browserMetricsStartCalls).toEqual([])
    expect(mocks.webVitalsStartCalls).toEqual([])
  })

  it('passes a metric recorder to Web Vitals startup without adding a default URL path dimension', async () => {
    const webVitalAttributes = () => ({ 'app.route': '/products/:id' })

    cleanup = configure({
      metrics: { metricUrl: 'http://localhost:8989/client-metrics' },
      rum: {
        webVitals: {
          metrics: {
            attributes: webVitalAttributes,
          },
        },
      },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    expect(mocks.browserMetricsRecorderCreateCalls).toHaveLength(1)
    expect((mocks.browserMetricsRecorderCreateCalls[0] as { attributes?: unknown }).attributes).toBe(webVitalAttributes)
    expect((mocks.browserMetricsRecorderCreateCalls[0] as { defaultAttributes?: unknown }).defaultAttributes).toBeUndefined()
    expect(mocks.webVitalsStartCalls).toHaveLength(1)
    expect((mocks.webVitalsStartCalls[0] as { metricRecorder?: unknown }).metricRecorder).toBe(mocks.browserMetricsRecorders[0])
    const spanProcessors = getLatestSpanProcessors()
    expect(spanProcessors[0]).toBeInstanceOf(BrowserSessionSpanProcessor)
  })

  it('force-flushes and shuts down browser metrics before trace cleanup', async () => {
    cleanup = configure({
      metrics: { metricUrl: 'http://localhost:8989/client-metrics' },
      traceUrl: 'http://localhost:8989/client-traces',
    })
    await waitForConfigureMicrotasks()

    const cleanupPromise = cleanup()
    await cleanupPromise

    expect(cleanup()).toBe(cleanupPromise)
    expect(mocks.browserMetricsForceFlushCalls).toBe(1)
    expect(mocks.browserMetricsShutdownCalls).toBe(1)
    expect(mocks.cleanupStepCalls).toEqual(['unregister', 'metricForceFlush', 'metricShutdown', 'forceFlush', 'shutdown'])
  })
})

describe('browser cleanup', () => {
  beforeEach(() => {
    mocks.reset()
    cleanup = undefined
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        language: 'en-US',
        userAgent: 'test-browser',
        userAgentData: undefined,
      },
    })
  })

  afterEach(async () => {
    await cleanup?.()
    clearConfiguredBrowserSessionForTests()
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
    vi.restoreAllMocks()
  })

  it('unregisters instrumentation, flushes, and shuts down once when called repeatedly', async () => {
    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const firstCleanup = cleanup()
    await firstCleanup
    const secondCleanup = cleanup()
    expect(secondCleanup).toBe(firstCleanup)
    await secondCleanup

    const tracerProvider = getLatestWebTracerProvider()
    expect(mocks.unregisterCalls).toBe(1)
    expect(tracerProvider.forceFlushCalls).toBe(1)
    expect(tracerProvider.shutdownCalls).toBe(1)
    expect(mocks.cleanupStepCalls).toEqual(['unregister', 'forceFlush', 'shutdown'])
  })

  it('shares the same in-flight promise for concurrent cleanup calls', async () => {
    cleanup = configure({
      traceUrl: 'http://localhost:8989/client-traces',
    })

    const firstCleanup = cleanup()
    const secondCleanup = cleanup()

    expect(secondCleanup).toBe(firstCleanup)
    await firstCleanup

    const tracerProvider = getLatestWebTracerProvider()
    expect(mocks.unregisterCalls).toBe(1)
    expect(tracerProvider.forceFlushCalls).toBe(1)
    expect(tracerProvider.shutdownCalls).toBe(1)
  })

  it('memoizes cleanup failure from unregister without retrying later', async () => {
    expect.hasAssertions()
    await expectCleanupFailureIsMemoized('unregister')
  })

  it('memoizes cleanup failure from forceFlush without retrying later', async () => {
    expect.hasAssertions()
    await expectCleanupFailureIsMemoized('forceFlush')
  })

  it('memoizes cleanup failure from shutdown without retrying later', async () => {
    expect.hasAssertions()
    await expectCleanupFailureIsMemoized('shutdown')
  })
})

function createMockContextManager(): ContextManager {
  return {
    active: () => ROOT_CONTEXT,
    bind: <T>(_context: Context, target: T): T => target,
    disable() {
      return this
    },
    enable() {
      return this
    },
    with: <A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      _context: Context,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> => Reflect.apply(fn, thisArg, args),
  }
}
