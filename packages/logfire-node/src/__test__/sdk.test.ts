/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { MockInstance } from 'vite-plus/test'

const mocks = vi.hoisted(() => {
  const nodeSdkInstances: MockNodeSDK[] = []
  let logForceFlushCalls = 0
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
    get logForceFlushCalls() {
      return logForceFlushCalls
    },
    logProcessor,
    MockNodeSDK,
    nodeSdkInstances,
    reset() {
      logForceFlushCalls = 0
      traceForceFlushCalls = 0
      nodeSdkInstances.length = 0
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

let processOnSpy: MockInstance<typeof process.on>
let processRemoveListenerSpy: MockInstance<typeof process.removeListener>

describe('sdk lifecycle helpers', () => {
  beforeEach(() => {
    mocks.reset()
    processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    processRemoveListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process)
  })

  afterEach(async () => {
    await shutdown()
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
})
