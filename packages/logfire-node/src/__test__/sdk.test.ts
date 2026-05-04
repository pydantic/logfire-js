/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { MockInstance } from 'vite-plus/test'

const mocks = vi.hoisted(() => {
  const nodeSdkInstances: MockNodeSDK[] = []
  const configureVariablesCalls: unknown[][] = []
  let logForceFlushCalls = 0
  let shutdownVariablesCalls = 0
  let traceForceFlushCalls = 0

  const logProcessor = {
    forceFlush: async () => {
      logForceFlushCalls++
      return Promise.resolve()
    },
    onEmit: () => undefined,
    shutdown: async () => Promise.resolve(),
  }
  const traceProcessor = {
    forceFlush: async () => {
      traceForceFlushCalls++
      return Promise.resolve()
    },
    onEnd: () => undefined,
    onStart: () => undefined,
    shutdown: async () => Promise.resolve(),
  }

  class MockNodeSDK {
    options: unknown
    shutdownCalls = 0

    constructor(options: unknown) {
      this.options = options
      nodeSdkInstances.push(this)
    }

    async shutdown(): Promise<void> {
      this.shutdownCalls++
      return Promise.resolve()
    }

    start(): void {
      return undefined
    }
  }

  return {
    configureVariablesCalls,
    get logForceFlushCalls() {
      return logForceFlushCalls
    },
    logProcessor,
    MockNodeSDK,
    nodeSdkInstances,
    reset() {
      configureVariablesCalls.length = 0
      logForceFlushCalls = 0
      shutdownVariablesCalls = 0
      traceForceFlushCalls = 0
      nodeSdkInstances.length = 0
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
    traceProcessor,
  }
})

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}))

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mocks.MockNodeSDK,
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
  periodicMetricReader: () => undefined,
}))

vi.mock('../traceExporter', () => ({
  logfireSpanProcessor: () => mocks.traceProcessor,
}))

import { forceFlush, shutdown, start } from '../sdk'
import { logfireConfig } from '../logfireConfig'

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

describe('sdk lifecycle helpers', () => {
  beforeEach(() => {
    mocks.reset()
    delete process.env['OTEL_RESOURCE_ATTRIBUTES']
    Object.assign(logfireConfig, {
      apiKey: undefined,
      codeSource: undefined,
      deploymentEnvironment: undefined,
      resourceAttributes: {},
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

  it('forceFlush flushes both trace and log processors', async () => {
    start()

    await forceFlush()

    expect(mocks.traceForceFlushCalls).toBe(1)
    expect(mocks.logForceFlushCalls).toBe(1)
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

  it('start shuts down the previous SDK and replaces process listeners', () => {
    start()
    const first = mocks.nodeSdkInstances[0]
    if (first === undefined) {
      throw new Error('expected first NodeSDK mock instance')
    }
    const firstListenerCalls = processOnSpy.mock.calls.map(([event, listener]) => [event, listener])

    start()

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
