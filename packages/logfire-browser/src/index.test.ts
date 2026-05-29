/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => {
  const cleanupStepCalls: string[] = []
  const failures = new Map<string, unknown>()
  const webTracerProviderInstances: MockWebTracerProvider[] = []
  let unregisterCalls = 0

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

  return {
    MockWebTracerProvider,
    cleanupStepCalls,
    failStep(step: 'unregister' | 'forceFlush' | 'shutdown', error: unknown) {
      failures.set(step, error)
    },
    get unregisterCalls() {
      return unregisterCalls
    },
    reset() {
      cleanupStepCalls.length = 0
      failures.clear()
      unregisterCalls = 0
      webTracerProviderInstances.length = 0
    },
    unregister() {
      cleanupStepCalls.push('unregister')
      unregisterCalls++
      if (failures.has('unregister')) {
        throw failures.get('unregister')
      }
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

import { PendingSpanProcessor, TailSamplingProcessor } from 'logfire'

import logfireBrowser, { configure, instrument, startPendingSpan, withSettings, withTags } from './index'

const originalNavigator = globalThis.navigator
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

  it('re-exports instrument from the shared API', () => {
    expect(logfireBrowser.instrument).toBe(instrument)
  })

  it('re-exports scoped client helpers from the shared API', () => {
    expect(logfireBrowser.withSettings).toBe(withSettings)
    expect(logfireBrowser.withTags).toBe(withTags)
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
    await expectCleanupFailureIsMemoized('unregister')
  })

  it('memoizes cleanup failure from forceFlush without retrying later', async () => {
    await expectCleanupFailureIsMemoized('forceFlush')
  })

  it('memoizes cleanup failure from shutdown without retrying later', async () => {
    await expectCleanupFailureIsMemoized('shutdown')
  })
})
