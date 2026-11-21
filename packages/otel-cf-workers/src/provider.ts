import type { Tracer, TracerOptions, TracerProvider } from '@opentelemetry/api'
import { context, trace } from '@opentelemetry/api'

import { AsyncLocalStorageContextManager } from './context.js'
import { WorkerTracer } from './tracer.js'

/**
 * Registered once per isolate. Span processors, resource, scope and ID generator are read
 * from the active request's config by `WorkerTracer`, so they are intentionally not held here.
 */
export class WorkerTracerProvider implements TracerProvider {
  private readonly tracers: Record<string, Tracer> = {}

  getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
    const key = `${name}@${version ?? ''}:${options?.schemaUrl ?? ''}`
    return (this.tracers[key] ??= new WorkerTracer())
  }

  register(): void {
    trace.setGlobalTracerProvider(this)
    context.setGlobalContextManager(new AsyncLocalStorageContextManager())
  }
}
