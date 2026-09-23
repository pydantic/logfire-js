import type { Context, TextMapGetter, TextMapPropagator, TextMapSetter } from '@opentelemetry/api'

/**
 * Keeps injecting trace context into outgoing requests while ignoring incoming context,
 * matching Python's `NoExtractTraceContextPropagator` for `distributed_tracing=False`.
 */
export class NoExtractPropagator implements TextMapPropagator {
  private readonly propagator: TextMapPropagator

  constructor(propagator: TextMapPropagator) {
    this.propagator = propagator
  }

  extract(context: Context, _carrier: unknown, _getter: TextMapGetter): Context {
    return context
  }

  fields(): string[] {
    return this.propagator.fields()
  }

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    this.propagator.inject(context, carrier, setter)
  }
}
