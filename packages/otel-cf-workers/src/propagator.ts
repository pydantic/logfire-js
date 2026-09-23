import type { Context, TextMapGetter, TextMapPropagator, TextMapSetter } from '@opentelemetry/api'

import { getActiveConfig, getConfig } from './config.js'

/**
 * The global propagator is registered once per isolate, but each request may resolve a
 * different config. Delegating keeps `propagation.inject/extract` on the request's propagator.
 */
export class ActiveConfigPropagator implements TextMapPropagator {
  private readonly fallback: TextMapPropagator

  constructor(fallback: TextMapPropagator) {
    this.fallback = fallback
  }

  private propagatorFor(context: Context): TextMapPropagator {
    return getConfig(context)?.propagator ?? this.fallback
  }

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    this.propagatorFor(context).inject(context, carrier, setter)
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.propagatorFor(context).extract(context, carrier, getter)
  }

  fields(): string[] {
    return (getActiveConfig()?.propagator ?? this.fallback).fields()
  }
}
