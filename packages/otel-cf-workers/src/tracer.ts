import type { Attributes, Context, Span, SpanOptions, Tracer } from '@opentelemetry/api'
import { SpanKind, TraceFlags, context as api_context, trace } from '@opentelemetry/api'
import type { InstrumentationScope } from '@opentelemetry/core'
import { sanitizeAttributes } from '@opentelemetry/core'
import type { Resource } from '@opentelemetry/resources'
import type { IdGenerator, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SamplingDecision } from '@opentelemetry/sdk-trace-base'

import { getActiveConfig } from './config.js'
import { SpanImpl } from './span.js'

let withNextSpanAttributes: Attributes

export class WorkerTracer implements Tracer {
  private readonly _spanProcessors: SpanProcessor[]
  private readonly resource: Resource
  private readonly scope: InstrumentationScope
  private readonly idGenerator: IdGenerator
  constructor(spanProcessors: SpanProcessor[], resource: Resource, scope: InstrumentationScope, idGenerator: IdGenerator) {
    this._spanProcessors = spanProcessors
    this.resource = resource
    this.scope = scope
    this.idGenerator = idGenerator
  }

  get spanProcessors(): SpanProcessor[] {
    return this._spanProcessors
  }

  addToResource(extra: Resource): void {
    this.resource.merge(extra)
  }

  startSpan(name: string, options: SpanOptions = {}, context: Context = api_context.active()): Span {
    if (options.root === true) {
      context = trace.deleteSpan(context)
    }
    const parentSpan = trace.getSpan(context)
    const parentSpanContext = parentSpan?.spanContext()
    const hasParentContext = parentSpanContext !== undefined && trace.isSpanContextValid(parentSpanContext)

    const traceId = hasParentContext ? parentSpanContext.traceId : this.idGenerator.generateTraceId()
    const spanKind = options.kind ?? SpanKind.INTERNAL
    const sanitisedAttrs = sanitizeAttributes(options.attributes)

    const config = getActiveConfig()
    if (!config) {
      throw new Error('Config is undefined. This is a bug in the instrumentation logic')
    }

    const sampler = config.sampling.headSampler
    const samplingDecision = sampler.shouldSample(context, traceId, name, spanKind, sanitisedAttrs, [])
    const { decision, traceState, attributes: attrs } = samplingDecision

    const attributes = { ...sanitisedAttrs, ...attrs, ...withNextSpanAttributes }
    withNextSpanAttributes = {}

    const spanId = this.idGenerator.generateSpanId()
    const parentSpanId = hasParentContext ? parentSpanContext.spanId : undefined
    const traceFlags = decision === SamplingDecision.RECORD_AND_SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE
    const spanContext = { traceId, spanId, traceFlags, ...(traceState !== undefined ? { traceState } : {}) }

    const span = new SpanImpl({
      attributes,
      name,
      onEnd: (span) => {
        this.spanProcessors.forEach((sp) => {
          sp.onEnd(span as unknown as ReadableSpan)
        })
      },
      resource: this.resource,
      scope: this.scope,
      spanContext,
      spanKind,
      ...(parentSpanContext !== undefined ? { parentSpanContext } : {}),
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
    })
    this.spanProcessors.forEach((sp) => {
      sp.onStart(span, context)
    })
    return span
  }

  startActiveSpan<F extends (span: Span) => ReturnType<F>>(name: string, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => ReturnType<F>>(name: string, options: SpanOptions, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => ReturnType<F>>(name: string, options: SpanOptions, context: Context, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => ReturnType<F>>(name: string, ...args: unknown[]): ReturnType<F> {
    const options = args.length > 1 ? (args[0] as SpanOptions) : {}
    const parentContext = args.length > 2 ? (args[1] as Context) : api_context.active()
    const fn = args[args.length - 1] as F

    const span = this.startSpan(name, options, parentContext)
    const contextWithSpanSet = trace.setSpan(parentContext, span)

    return api_context.with(contextWithSpanSet, fn, undefined, span)
  }
}

export function withNextSpan(attrs: Attributes): void {
  withNextSpanAttributes = { ...withNextSpanAttributes, ...attrs }
}
