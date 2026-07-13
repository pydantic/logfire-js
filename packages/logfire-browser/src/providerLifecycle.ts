import type { Context, ContextManager, Span, SpanOptions, Tracer, TracerOptions, TracerProvider } from '@opentelemetry/api'
import { context, INVALID_SPAN_CONTEXT, propagation, trace } from '@opentelemetry/api'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { StackContextManager } from '@opentelemetry/sdk-trace-web'

export const ACTIVE_CONFIGURATION_ERROR = 'logfire-browser: a configuration is already active; await its cleanup before configuring again'
export const FAILED_CLEANUP_ERROR = 'logfire-browser: the previous cleanup failed; reload the page before configuring again'
export const FAILED_CONTEXT_ROLLBACK_ERROR =
  'logfire-browser: context manager initialization failed and could not be rolled back; reload the page before configuring again'

const EXTERNAL_CONTEXT_CONFLICT_ERROR =
  'logfire-browser: an OpenTelemetry context manager is already registered; omit contextManager to use the application-owned manager'
const CHANGED_CONTEXT_MANAGER_ERROR = 'logfire-browser: contextManager cannot change after Logfire context initialization'

export type ProviderGenerationToken = symbol

type GenerationState =
  | { status: 'idle' }
  | { status: 'active'; provider: TracerProvider; token: ProviderGenerationToken }
  | { delegateActive: boolean; status: 'cleaning'; provider: TracerProvider; token: ProviderGenerationToken }
  | { error: Error; status: 'failed'; token?: ProviderGenerationToken | undefined }

type TraceOwnership = { status: 'external' | 'logfire' | 'uninitialized' }
type ContextOwnership =
  | { status: 'uninitialized' }
  | { contextManager: ContextManager; status: 'logfire' }
  | { status: 'external' }
  | { error: Error; status: 'failed' }
type PropagationOwnership = { status: 'external' | 'logfire' | 'uninitialized' }

class DelegatingTracerProvider implements TracerProvider {
  private readonly getCurrentProvider: () => TracerProvider | undefined

  constructor(getCurrentProvider: () => TracerProvider | undefined) {
    this.getCurrentProvider = getCurrentProvider
  }

  getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
    return new DelegatingTracer(this.getCurrentProvider, name, version, options)
  }
}

class DelegatingTracer implements Tracer {
  private readonly getCurrentProvider: () => TracerProvider | undefined
  private readonly name: string
  private readonly options: TracerOptions | undefined
  private readonly version: string | undefined

  constructor(getCurrentProvider: () => TracerProvider | undefined, name: string, version?: string, options?: TracerOptions) {
    this.getCurrentProvider = getCurrentProvider
    this.name = name
    this.version = version
    this.options = options
  }

  startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
    const delegate = this.getDelegate()
    return delegate?.startSpan(name, options, parentContext) ?? trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, parentContext: Context, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrCallback: SpanOptions | F,
    contextOrCallback?: Context | F,
    callback?: F
  ): ReturnType<F> {
    const delegate = this.getDelegate()
    if (delegate !== undefined) {
      if (typeof optionsOrCallback === 'function') {
        return delegate.startActiveSpan(name, optionsOrCallback)
      }
      if (typeof contextOrCallback === 'function') {
        return delegate.startActiveSpan(name, optionsOrCallback, contextOrCallback)
      }
      return delegate.startActiveSpan(name, optionsOrCallback, contextOrCallback as Context, callback as F)
    }

    const inactiveSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
    const activeCallback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : typeof contextOrCallback === 'function'
          ? contextOrCallback
          : (callback as F)
    const parentContext =
      typeof optionsOrCallback === 'function' || typeof contextOrCallback === 'function'
        ? context.active()
        : (contextOrCallback ?? context.active())
    return context.with(
      trace.setSpan(parentContext, inactiveSpan),
      activeCallback as (span: Span) => ReturnType<F>,
      undefined,
      inactiveSpan
    )
  }

  private getDelegate(): Tracer | undefined {
    return this.getCurrentProvider()?.getTracer(this.name, this.version, this.options)
  }
}

class BrowserProviderLifecycle {
  private contextOwnership: ContextOwnership = { status: 'uninitialized' }
  private generation: GenerationState = { status: 'idle' }
  private propagationOwnership: PropagationOwnership = { status: 'uninitialized' }
  private traceOwnership: TraceOwnership = { status: 'uninitialized' }
  readonly stableProvider = new DelegatingTracerProvider(() => this.getCurrentProvider())

  assertAvailable(): void {
    if (this.contextOwnership.status === 'failed') {
      throw this.contextOwnership.error
    }
    if (this.generation.status === 'failed') {
      throw new Error(FAILED_CLEANUP_ERROR, { cause: this.generation.error })
    }
    if (this.generation.status !== 'idle') {
      throw new Error(ACTIVE_CONFIGURATION_ERROR)
    }
  }

  initializeGlobals(requestedContextManager: ContextManager | undefined): void {
    this.assertAvailable()
    this.initializeContext(requestedContextManager)
    this.initializeTrace()
    this.initializePropagation()
  }

  activate(provider: TracerProvider): ProviderGenerationToken {
    this.assertAvailable()
    const token = Symbol('logfire-browser-provider-generation')
    this.generation = { provider, status: 'active', token }
    return token
  }

  beginCleanup(token: ProviderGenerationToken): void {
    if (this.generation.status === 'active' && this.generation.token === token) {
      this.generation = { delegateActive: true, provider: this.generation.provider, status: 'cleaning', token }
    }
  }

  deactivateDelegate(token: ProviderGenerationToken): void {
    if (this.generation.status === 'cleaning' && this.generation.token === token) {
      this.generation.delegateActive = false
    }
  }

  settleCleanup(token: ProviderGenerationToken, error?: Error): void {
    if (this.generation.status !== 'cleaning' || this.generation.token !== token) {
      return
    }
    this.generation = error === undefined ? { status: 'idle' } : { error, status: 'failed', token: this.generation.token }
  }

  rollbackActivation(token: ProviderGenerationToken, error?: Error): void {
    if (this.generation.status !== 'active' || this.generation.token !== token) {
      return
    }
    this.generation = error === undefined ? { status: 'idle' } : { error, status: 'failed', token }
  }

  resetForTests(): void {
    this.generation = { status: 'idle' }
    this.contextOwnership = { status: 'uninitialized' }
    this.traceOwnership = { status: 'uninitialized' }
    this.propagationOwnership = { status: 'uninitialized' }
    safelyDisable(() => {
      context.disable()
    })
    safelyDisable(() => {
      propagation.disable()
    })
    safelyDisable(() => {
      trace.disable()
    })
  }

  getStateForTests(): GenerationState {
    return this.generation
  }

  private getCurrentProvider(): TracerProvider | undefined {
    if (this.generation.status === 'active') {
      return this.generation.provider
    }
    if (this.generation.status === 'cleaning' && this.generation.delegateActive) {
      return this.generation.provider
    }
    return undefined
  }

  private initializeContext(requestedContextManager: ContextManager | undefined): void {
    if (this.contextOwnership.status === 'failed') {
      throw this.contextOwnership.error
    }
    if (this.contextOwnership.status === 'logfire') {
      if (requestedContextManager !== undefined && requestedContextManager !== this.contextOwnership.contextManager) {
        throw new Error(CHANGED_CONTEXT_MANAGER_ERROR)
      }
      return
    }
    if (this.contextOwnership.status === 'external') {
      if (requestedContextManager !== undefined) {
        throw new Error(EXTERNAL_CONTEXT_CONFLICT_ERROR)
      }
      return
    }

    const contextManager = requestedContextManager ?? new StackContextManager()
    if (!context.setGlobalContextManager(contextManager)) {
      this.contextOwnership = { status: 'external' }
      if (requestedContextManager !== undefined) {
        throw new Error(EXTERNAL_CONTEXT_CONFLICT_ERROR)
      }
      return
    }

    try {
      contextManager.enable()
      this.contextOwnership = { contextManager, status: 'logfire' }
    } catch (enableError) {
      try {
        context.disable()
        this.contextOwnership = { status: 'uninitialized' }
      } catch (rollbackError) {
        const error = new Error(FAILED_CONTEXT_ROLLBACK_ERROR, {
          cause: { enableError, rollbackError },
        })
        this.contextOwnership = { error, status: 'failed' }
        throw error
      }
      throw enableError
    }
  }

  private initializeTrace(): void {
    if (this.traceOwnership.status !== 'uninitialized') {
      return
    }
    this.traceOwnership = { status: trace.setGlobalTracerProvider(this.stableProvider) ? 'logfire' : 'external' }
  }

  private initializePropagation(): void {
    if (this.propagationOwnership.status !== 'uninitialized') {
      return
    }
    const propagator = new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    })
    this.propagationOwnership = { status: propagation.setGlobalPropagator(propagator) ? 'logfire' : 'external' }
  }
}

function safelyDisable(disable: () => void): void {
  try {
    disable()
  } catch {
    // Isolated tests may intentionally install a manager whose disable throws.
  }
}

const providerLifecycle = new BrowserProviderLifecycle()

export function assertProviderLifecycleAvailable(): void {
  providerLifecycle.assertAvailable()
}

export function initializeProviderLifecycleGlobals(contextManager?: ContextManager): void {
  providerLifecycle.initializeGlobals(contextManager)
}

export function activateProviderGeneration(provider: TracerProvider): ProviderGenerationToken {
  return providerLifecycle.activate(provider)
}

export function beginProviderCleanup(token: ProviderGenerationToken): void {
  providerLifecycle.beginCleanup(token)
}

export function deactivateProviderDelegate(token: ProviderGenerationToken): void {
  providerLifecycle.deactivateDelegate(token)
}

export function settleProviderCleanup(token: ProviderGenerationToken, error?: Error): void {
  providerLifecycle.settleCleanup(token, error)
}

export function rollbackProviderGeneration(token: ProviderGenerationToken, error?: Error): void {
  providerLifecycle.rollbackActivation(token, error)
}

export function getStableBrowserTracer(scope: string, version?: string, options?: TracerOptions): Tracer {
  return providerLifecycle.stableProvider.getTracer(scope, version, options)
}

export function resetProviderLifecycleForTests(): void {
  providerLifecycle.resetForTests()
}

export function getProviderLifecycleStateForTests(): GenerationState {
  return providerLifecycle.getStateForTests()
}
