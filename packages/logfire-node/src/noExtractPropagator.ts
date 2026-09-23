import type { Context, TextMapGetter, TextMapPropagator, TextMapSetter } from '@opentelemetry/api'
import { trace } from '@opentelemetry/api'

/**
 * Keeps injecting trace context into outgoing requests while ignoring incoming trace context,
 * matching Python's `NoExtractTraceContextPropagator` for `distributed_tracing=False`.
 * Other extracted values, such as baggage, are kept.
 */
export class NoExtractPropagator implements TextMapPropagator {
  private readonly propagator: TextMapPropagator

  constructor(propagator: TextMapPropagator) {
    this.propagator = propagator
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const extracted = this.propagator.extract(context, carrier, getter)
    const currentSpan = trace.getSpan(context)
    return currentSpan === undefined ? trace.deleteSpan(extracted) : trace.setSpan(extracted, currentSpan)
  }

  fields(): string[] {
    return this.propagator.fields()
  }

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    this.propagator.inject(context, carrier, setter)
  }
}
