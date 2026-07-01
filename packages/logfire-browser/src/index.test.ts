/* eslint-disable import/first */
import type { SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => {
  const cleanupStepCalls: string[] = []
  const failures = new Map<string, unknown>()
  const browserMetricsRecorderCreateCalls: unknown[] = []
  const browserMetricsStartCalls: { options: unknown; resource: unknown }[] = []
  const browserMetricsRecorders: unknown[] = []
  const lifecycleEvents: string[] = []
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
    registerCalls = 0
    shutdownCalls = 0

    constructor(options: unknown) {
      this.options = options
      webTracerProviderInstances.push(this)
    }

    register(): void {
      lifecycleEvents.push('providerRegister')
      this.registerCalls++
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
    browserMetricsStartCalls,
    cleanupStepCalls,
    createBrowserMetricsRuntime,
    createWebVitalsHandle,
    failStep(step: 'metricForceFlush' | 'metricShutdown' | 'unregister' | 'forceFlush' | 'shutdown', error: unknown) {
      failures.set(step, error)
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
    reset() {
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
  registerInstrumentations: () => () => {
    mocks.unregister()
  },
}))

vi.mock('@opentelemetry/sdk-trace-web', () => ({
  BatchSpanProcessor: class MockBatchSpanProcessor {
    exporter: unknown
    config: unknown

    constructor(exporter: unknown, config: unknown) {
      this.exporter = exporter
      this.config = config
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
import logfireBrowser, { configure, getBrowserSessionId, instrument, startPendingSpan, withSettings, withTags } from './index'
import type { BrowserSessionReplayRuntime } from './sessionReplay'

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

  it('lazily creates a configured browser session id before the first span', () => {
    cleanup = configure({
      rum: { session: true },
      traceUrl: 'http://localhost:8989/client-traces',
    })

    expect(getBrowserSessionId()).toEqual(expect.any(String))
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

    expect(mocks.webVitalsStartCalls).toEqual([{}])
    expect(mocks.lifecycleEvents).toEqual(['providerRegister', 'webVitalsStart'])
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

    expect(mocks.webVitalsStartCalls).toEqual([
      {
        generateTarget,
        includeProcessedEventEntries: true,
        reportAllChanges: true,
      },
    ])
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
    expect(mocks.lifecycleEvents).toEqual(['providerRegister', 'sessionReplayLoad'])
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

    expect(getLatestWebTracerProvider().registerCalls).toBe(1)
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
    expect(mocks.lifecycleEvents).toEqual(['providerRegister', 'browserMetricsStart'])
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
