/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => {
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
      this.forceFlushCalls++
      return Promise.resolve()
    }

    async shutdown(): Promise<void> {
      this.shutdownCalls++
      return Promise.resolve()
    }
  }

  return {
    MockWebTracerProvider,
    get unregisterCalls() {
      return unregisterCalls
    },
    reset() {
      unregisterCalls = 0
      webTracerProviderInstances.length = 0
    },
    unregister() {
      unregisterCalls++
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

import { configure } from './index'

const originalNavigator = globalThis.navigator
let cleanup: (() => Promise<void>) | undefined

function getLatestResourceAttributes(): Record<string, unknown> {
  const instance = mocks.webTracerProviderInstances[mocks.webTracerProviderInstances.length - 1]
  expect(instance).toBeDefined()
  if (instance === undefined) {
    throw new Error('expected WebTracerProvider mock instance')
  }
  return (instance.options as { resource: { attributes: Record<string, unknown> } }).resource.attributes
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
