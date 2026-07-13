import type { Context, ContextManager, Tracer, TracerProvider } from '@opentelemetry/api'
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { Sampler, SamplingResult } from '@opentelemetry/sdk-trace-web'
import { InMemorySpanExporter, SamplingDecision, SimpleSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  ACTIVE_CONFIGURATION_ERROR,
  activateProviderGeneration,
  assertProviderLifecycleAvailable,
  beginProviderCleanup,
  deactivateProviderDelegate,
  FAILED_CLEANUP_ERROR,
  FAILED_CONTEXT_ROLLBACK_ERROR,
  getProviderLifecycleStateForTests,
  getStableBrowserTracer,
  initializeProviderLifecycleGlobals,
  resetProviderLifecycleForTests,
  rollbackProviderGeneration,
  settleProviderCleanup,
} from './providerLifecycle'

let failedDisableManager: TestContextManager | undefined

afterEach(() => {
  if (failedDisableManager !== undefined) {
    failedDisableManager.disableEffect = () => undefined
  }
  failedDisableManager = undefined
  resetProviderLifecycleForTests()
  vi.restoreAllMocks()
})

describe('provider lifecycle delegation', () => {
  it('routes tracers cached before registration through A, inactive, and B without migrating existing spans', async () => {
    const cachedGlobalTracer = trace.getTracer('cached-before-registration')
    const stableTracer = getStableBrowserTracer('manual-logfire')
    initializeProviderLifecycleGlobals()
    const a = createRecordingProvider('A')
    const b = createRecordingProvider('B')

    const tokenA = activateProviderGeneration(a.provider)
    cachedGlobalTracer.startSpan('cached-a').end()
    stableTracer.startSpan('manual-a').end()
    const heldA = cachedGlobalTracer.startSpan('held-a')

    beginProviderCleanup(tokenA)
    deactivateProviderDelegate(tokenA)
    expect(cachedGlobalTracer.startSpan('inactive').isRecording()).toBe(false)
    settleProviderCleanup(tokenA)

    const tokenB = activateProviderGeneration(b.provider)
    deactivateProviderDelegate(tokenA)
    cachedGlobalTracer.startSpan('cached-b').end()
    stableTracer.startSpan('manual-b').end()
    heldA.end()

    await Promise.all([a.provider.forceFlush(), b.provider.forceFlush()])
    expect(a.exporter.getFinishedSpans().map((span) => span.name)).toEqual(['cached-a', 'manual-a', 'held-a'])
    expect(b.exporter.getFinishedSpans().map((span) => span.name)).toEqual(['cached-b', 'manual-b'])
    expect(a.exporter.getFinishedSpans().every((span) => span.resource.attributes['generation'] === 'A')).toBe(true)
    expect(b.exporter.getFinishedSpans().every((span) => span.resource.attributes['generation'] === 'B')).toBe(true)
    expect(a.exporter.getFinishedSpans().every((span) => span.attributes['test.sampler.generation'] === 'A')).toBe(true)
    expect(b.exporter.getFinishedSpans().every((span) => span.attributes['test.sampler.generation'] === 'B')).toBe(true)
    expect(getProviderLifecycleStateForTests()).toMatchObject({ status: 'active', token: tokenB })

    beginProviderCleanup(tokenB)
    deactivateProviderDelegate(tokenB)
    settleProviderCleanup(tokenB)
    await Promise.all([a.provider.shutdown(), b.provider.shutdown()])
  })

  it('forwards tracer identity and startSpan options/context exactly', () => {
    initializeProviderLifecycleGlobals()
    const delegatedSpan = trace.wrapSpanContext({
      isRemote: false,
      spanId: '1234567890abcdef',
      traceFlags: 1,
      traceId: '1234567890abcdef1234567890abcdef',
    })
    const startSpan = vi.fn<Tracer['startSpan']>(() => delegatedSpan)
    const delegate = { startActiveSpan: vi.fn<Tracer['startActiveSpan']>(), startSpan } as unknown as Tracer
    const getTracer = vi.fn<TracerProvider['getTracer']>(() => delegate)
    const provider: TracerProvider = { getTracer }
    activateProviderGeneration(provider)
    const tracerOptions = { schemaUrl: 'https://example.test/schema' }
    const stableTracer = getStableBrowserTracer('scope', '1.2.3', tracerOptions)
    const spanOptions = { attributes: { exact: true }, kind: 1 }
    const parentContext = ROOT_CONTEXT.setValue(Symbol('explicit-parent'), 'present')

    expect(stableTracer.startSpan('exact-span', spanOptions, parentContext)).toBe(delegatedSpan)
    expect(getTracer).toHaveBeenCalledWith('scope', '1.2.3', tracerOptions)
    expect(startSpan).toHaveBeenCalledWith('exact-span', spanOptions, parentContext)
  })

  it('preserves every active-span overload and inactive callback context/return values', async () => {
    initializeProviderLifecycleGlobals()
    const recording = createRecordingProvider('active')
    const token = activateProviderGeneration(recording.provider)
    const tracer = getStableBrowserTracer('overloads')
    const explicitParent = ROOT_CONTEXT.setValue(Symbol('parent'), 'value')

    expect(tracer.startActiveSpan('one', (span) => (span.end(), 'one-result'))).toBe('one-result')
    expect(tracer.startActiveSpan('two', { attributes: { form: 2 } }, (span) => (span.end(), 'two-result'))).toBe('two-result')
    expect(tracer.startActiveSpan('three', { attributes: { form: 3 } }, explicitParent, (span) => (span.end(), 'three-result'))).toBe(
      'three-result'
    )

    beginProviderCleanup(token)
    deactivateProviderDelegate(token)
    const inactiveResult = tracer.startActiveSpan('inactive', { attributes: { ignored: true } }, explicitParent, (span) => {
      expect(span.isRecording()).toBe(false)
      expect(trace.getSpan(context.active())).toBe(span)
      return 'inactive-result'
    })
    expect(inactiveResult).toBe('inactive-result')
    settleProviderCleanup(token)

    await recording.provider.forceFlush()
    expect(recording.exporter.getFinishedSpans().map((span) => span.name)).toEqual(['one', 'two', 'three'])
    await recording.provider.shutdown()
  })

  it('keeps cleaning distinct from delegate deactivation and cleanup settlement', () => {
    initializeProviderLifecycleGlobals()
    const token = activateProviderGeneration(createNoopProvider())
    expect(() => {
      assertProviderLifecycleAvailable()
    }).toThrow(ACTIVE_CONFIGURATION_ERROR)

    beginProviderCleanup(token)
    deactivateProviderDelegate(token)
    expect(getProviderLifecycleStateForTests()).toMatchObject({ delegateActive: false, status: 'cleaning', token })
    expect(() => {
      assertProviderLifecycleAvailable()
    }).toThrow(ACTIVE_CONFIGURATION_ERROR)

    settleProviderCleanup(token)
    expect(() => {
      assertProviderLifecycleAvailable()
    }).not.toThrow()
  })

  it('enters a terminal state after cleanup failure but permits proven activation rollback', () => {
    initializeProviderLifecycleGlobals()
    const token = activateProviderGeneration(createNoopProvider())
    rollbackProviderGeneration(token)
    expect(() => {
      assertProviderLifecycleAvailable()
    }).not.toThrow()

    const nextToken = activateProviderGeneration(createNoopProvider())
    beginProviderCleanup(nextToken)
    deactivateProviderDelegate(nextToken)
    settleProviderCleanup(nextToken, new Error('shutdown failed'))
    expect(() => {
      assertProviderLifecycleAvailable()
    }).toThrow(FAILED_CLEANUP_ERROR)
  })
})

describe('provider lifecycle context ownership', () => {
  it('retains the first Logfire manager and rejects a different identity untouched', () => {
    const first = new TestContextManager()
    const different = new TestContextManager()
    initializeProviderLifecycleGlobals(first)

    expect(first.enableCalls).toHaveBeenCalledTimes(1)
    expect(() => {
      initializeProviderLifecycleGlobals(first)
    }).not.toThrow()
    expect(() => {
      initializeProviderLifecycleGlobals()
    }).not.toThrow()
    expect(() => {
      initializeProviderLifecycleGlobals(different)
    }).toThrow('contextManager cannot change')
    expect(different.enableCalls).not.toHaveBeenCalled()
    expect(different.disableCalls).not.toHaveBeenCalled()
  })

  it('uses an application-owned context manager when omitted and rejects an explicit candidate untouched', () => {
    const applicationManager = new TestContextManager()
    expect(context.setGlobalContextManager(applicationManager)).toBe(true)
    applicationManager.enable()

    initializeProviderLifecycleGlobals()
    const candidate = new TestContextManager()
    expect(() => {
      initializeProviderLifecycleGlobals(candidate)
    }).toThrow('omit contextManager')
    expect(candidate.enableCalls).not.toHaveBeenCalled()
    expect(candidate.disableCalls).not.toHaveBeenCalled()
    expect(applicationManager.disableCalls).not.toHaveBeenCalled()
  })

  it('rolls back an ownership-proven enable failure and permits retry', () => {
    const failing = new TestContextManager()
    const enableError = new Error('enable failed')
    failing.enableEffect = () => {
      throw enableError
    }

    expect(() => {
      initializeProviderLifecycleGlobals(failing)
    }).toThrow(enableError)
    expect(failing.disableCalls).toHaveBeenCalledTimes(1)

    const retry = new TestContextManager()
    expect(() => {
      initializeProviderLifecycleGlobals(retry)
    }).not.toThrow()
    expect(retry.enableCalls).toHaveBeenCalledTimes(1)
  })

  it('becomes terminal when ownership-proven context rollback fails', () => {
    const failing = new TestContextManager()
    failedDisableManager = failing
    failing.enableEffect = () => {
      throw new Error('enable failed')
    }
    failing.disableEffect = () => {
      throw new Error('disable failed')
    }

    expect(() => {
      initializeProviderLifecycleGlobals(failing)
    }).toThrow(FAILED_CONTEXT_ROLLBACK_ERROR)
    expect(() => {
      assertProviderLifecycleAvailable()
    }).toThrow(FAILED_CONTEXT_ROLLBACK_ERROR)
  })
})

function createRecordingProvider(generation: string) {
  const exporter = new InMemorySpanExporter()
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ generation }),
    sampler: new GenerationSampler(generation),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  return { exporter, provider }
}

class GenerationSampler implements Sampler {
  private readonly generation: string

  constructor(generation: string) {
    this.generation = generation
  }

  shouldSample(): SamplingResult {
    return {
      attributes: { 'test.sampler.generation': this.generation },
      decision: SamplingDecision.RECORD_AND_SAMPLED,
    }
  }

  toString(): string {
    return `GenerationSampler{${this.generation}}`
  }
}

function createNoopProvider(): TracerProvider {
  return new WebTracerProvider()
}

class TestContextManager implements ContextManager {
  readonly disableCalls = vi.fn<() => void>()
  disableEffect: () => void = () => undefined
  readonly enableCalls = vi.fn<() => void>()
  enableEffect: () => void = () => undefined

  active(): Context {
    return ROOT_CONTEXT
  }

  bind<T>(_context: Context, target: T): T {
    return target
  }

  disable(): this {
    this.disableCalls()
    this.disableEffect()
    return this
  }

  enable(): this {
    this.enableCalls()
    this.enableEffect()
    return this
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    _context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return Reflect.apply(fn, thisArg, args)
  }
}
