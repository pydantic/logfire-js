import type { Tracer, TracerOptions, TracerProvider } from '@opentelemetry/api'
import { context, trace } from '@opentelemetry/api'

import type { Resource } from '@opentelemetry/resources'
import type { IdGenerator, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import type { InstrumentationScope } from '@opentelemetry/core'
import { AsyncLocalStorageContextManager } from './context.js'
import { WorkerTracer } from './tracer.js'

/**
 * Register this TracerProvider for use with the OpenTelemetry API.
 * Undefined values may be replaced with defaults, and
 * null values will be skipped.
 *
 * @param config Configuration object for SDK registration
 */
export class WorkerTracerProvider implements TracerProvider {
  private readonly spanProcessors: SpanProcessor[]
  private readonly resource: Resource
  private readonly tracers: Record<string, Tracer> = {}
  private readonly scope: InstrumentationScope
  private readonly idGenerator: IdGenerator

  constructor(spanProcessors: SpanProcessor[], resource: Resource, scope: InstrumentationScope, idGenerator: IdGenerator) {
    this.spanProcessors = spanProcessors
    this.resource = resource
    this.scope = scope
    this.idGenerator = idGenerator
  }

  getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
    const key = `${name}@${version ?? ''}:${options?.schemaUrl ?? ''}`
    return (this.tracers[key] ??= new WorkerTracer(this.spanProcessors, this.resource, this.scope, this.idGenerator))
  }

  register(): void {
    trace.setGlobalTracerProvider(this)
    context.setGlobalContextManager(new AsyncLocalStorageContextManager())
  }
}
