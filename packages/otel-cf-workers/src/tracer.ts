import type { Attributes, Context, Span, SpanOptions, Tracer } from '@opentelemetry/api'
import { SpanKind, TraceFlags, context as api_context, trace } from '@opentelemetry/api'
import { sanitizeAttributes } from '@opentelemetry/core'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { SamplingDecision } from '@opentelemetry/sdk-trace-base'

import { getConfig } from './config.js'
import { SpanImpl } from './span.js'

let withNextSpanAttributes: Attributes

export class WorkerTracer implements Tracer {
  startSpan(name: string, options: SpanOptions = {}, context: Context = api_context.active()): Span {
    const config = getConfig(context)
    if (!config) {
      throw new Error('Config is undefined. This is a bug in the instrumentation logic')
    }
    // Captured at start so onEnd reaches the same processors that saw onStart.
    const { spanProcessors, resource, scope, idGenerator } = config

    if (options.root === true) {
      context = trace.deleteSpan(context)
    }
    const parentSpan = trace.getSpan(context)
    const parentSpanContext = parentSpan?.spanContext()
    const hasParentContext = parentSpanContext !== undefined && trace.isSpanContextValid(parentSpanContext)

    const traceId = hasParentContext ? parentSpanContext.traceId : idGenerator.generateTraceId()
    const spanKind = options.kind ?? SpanKind.INTERNAL
    const sanitisedAttrs = sanitizeAttributes(options.attributes)

    const sampler = config.sampling.headSampler
    const samplingDecision = sampler.shouldSample(context, traceId, name, spanKind, sanitisedAttrs, [])
    const { decision, traceState, attributes: attrs } = samplingDecision

    const attributes = { ...sanitisedAttrs, ...attrs, ...withNextSpanAttributes }
    withNextSpanAttributes = {}

    const spanId = idGenerator.generateSpanId()
    const parentSpanId = hasParentContext ? parentSpanContext.spanId : undefined
    const traceFlags = decision === SamplingDecision.RECORD_AND_SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE
    const spanContext = { traceId, spanId, traceFlags, ...(traceState !== undefined ? { traceState } : {}) }

    const span = new SpanImpl({
      attributes,
      name,
      onEnd: (span) => {
        spanProcessors.forEach((sp) => {
          sp.onEnd(span as unknown as ReadableSpan)
        })
      },
      resource,
      scope,
      spanContext,
      spanKind,
      ...(parentSpanContext !== undefined ? { parentSpanContext } : {}),
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
    })
    spanProcessors.forEach((sp) => {
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
