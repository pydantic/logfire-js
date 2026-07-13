/**
 * @vitest-environment jsdom
 */
import type { Context, TextMapPropagator, TextMapSetter } from '@opentelemetry/api'
import { context, propagation, trace } from '@opentelemetry/api'
import { InstrumentationBase } from '@opentelemetry/instrumentation'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { InMemorySpanExporter, SimpleSpanProcessor, StackContextManager, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'

import { configure, startSpan } from './index'
import { resetProviderLifecycleForTests } from './providerLifecycle'

const originalNavigator = globalThis.navigator
let cleanup: (() => Promise<void>) | undefined
let applicationProvider: WebTracerProvider | undefined
let traceUrl = ''
const exportServer = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    response.statusCode = 200
    response.end('{}')
  })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    exportServer.listen(0, '127.0.0.1', resolve)
  })
  const address = exportServer.address() as AddressInfo
  traceUrl = `http://127.0.0.1:${String(address.port)}/traces/logfire`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    exportServer.close((error) => {
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })
})

afterEach(async () => {
  await cleanup?.().catch(() => undefined)
  cleanup = undefined
  resetProviderLifecycleForTests()
  await applicationProvider?.shutdown()
  applicationProvider = undefined
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
  vi.restoreAllMocks()
})

describe('public configure mixed OpenTelemetry ownership', () => {
  it.each(
    Array.from({ length: 8 }, (_, mask) => ({
      externalContext: (mask & 2) !== 0,
      externalPropagation: (mask & 4) !== 0,
      externalTrace: (mask & 1) !== 0,
      mask,
    }))
  )('preserves independent application owners for combination $mask', async (ownership) => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'en-US', userAgent: 'test-browser', userAgentData: undefined },
    })

    const applicationExporter = new InMemorySpanExporter()
    let traceRegistrationSucceeded = true
    if (ownership.externalTrace) {
      applicationProvider = new WebTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(applicationExporter)],
      })
      traceRegistrationSucceeded = trace.setGlobalTracerProvider(applicationProvider)
    }
    expect(traceRegistrationSucceeded).toBe(true)
    const applicationTracer = trace.getTracer('application-owner')
    applicationTracer.startSpan('application-before').end()

    let applicationContext: TrackingContextManager | undefined
    let contextRegistrationSucceeded = true
    if (ownership.externalContext) {
      applicationContext = new TrackingContextManager()
      contextRegistrationSucceeded = context.setGlobalContextManager(applicationContext)
      applicationContext.enable()
    }
    expect(contextRegistrationSucceeded).toBe(true)

    const applicationPropagator = new TrackingPropagator()
    let propagationRegistrationSucceeded = true
    if (ownership.externalPropagation) {
      propagationRegistrationSucceeded = propagation.setGlobalPropagator(applicationPropagator)
    }
    expect(propagationRegistrationSucceeded).toBe(true)

    const logfireSpans: ReadableSpan[] = []
    const customInstrumentation = new TestInstrumentation()
    cleanup = configure({
      instrumentations: [customInstrumentation],
      resourceAttributes: { generation: `logfire-${String(ownership.mask)}` },
      spanProcessors: [createRecordingProcessor(logfireSpans)],
      traceUrl,
    })

    applicationTracer.startSpan('application-during').end()
    startSpan('manual-logfire').end()
    customInstrumentation.emit('instrumentation-logfire')
    const carrier: Record<string, string> = {}
    propagation.inject(context.active(), carrier)
    await cleanup()

    applicationTracer.startSpan('application-after').end()
    await applicationProvider?.forceFlush()

    expect(logfireSpans.map((span) => span.name)).toEqual(
      ownership.externalTrace
        ? ['manual-logfire', 'instrumentation-logfire']
        : ['application-during', 'manual-logfire', 'instrumentation-logfire']
    )
    expect(logfireSpans.every((span) => span.resource.attributes['generation'] === `logfire-${String(ownership.mask)}`)).toBe(true)
    expect(applicationExporter.getFinishedSpans().map((span) => span.name)).toEqual(
      ownership.externalTrace ? ['application-before', 'application-during', 'application-after'] : []
    )
    expect(applicationContext?.disableCalls ?? 0).toBe(0)
    expect(applicationPropagator.injectCalls).toBe(ownership.externalPropagation ? 1 : 0)
    expect(carrier['x-application-propagator']).toBe(ownership.externalPropagation ? 'present' : undefined)
    expect(customInstrumentation.disableCalls).toBe(1)
  })
})

class TestInstrumentation extends InstrumentationBase {
  disableCalls = 0

  constructor() {
    super('provider-lifecycle-test', '1.0.0', { enabled: false })
  }

  emit(name: string): void {
    this.tracer.startSpan(name).end()
  }

  override enable(): void {
    return undefined
  }

  override disable(): void {
    this.disableCalls += 1
  }

  protected init(): void {
    return undefined
  }
}

class TrackingContextManager extends StackContextManager {
  disableCalls = 0

  override disable(): this {
    this.disableCalls += 1
    return super.disable()
  }
}

class TrackingPropagator implements TextMapPropagator {
  injectCalls = 0

  extract(parentContext: Context): Context {
    return parentContext
  }

  fields(): string[] {
    return ['x-application-propagator']
  }

  inject<Carrier>(
    _context: Context,
    carrier: Carrier,
    setter: TextMapSetter<Carrier> = {
      set(target, key, value) {
        Reflect.set(target as object, key, value)
      },
    }
  ): void {
    this.injectCalls += 1
    setter.set(carrier, 'x-application-propagator', 'present')
  }
}

function createRecordingProcessor(spans: ReadableSpan[]): SpanProcessor {
  return {
    forceFlush: async () => Promise.resolve(),
    onEnd(span) {
      spans.push(span)
    },
    onStart() {
      return undefined
    },
    shutdown: async () => Promise.resolve(),
  }
}
