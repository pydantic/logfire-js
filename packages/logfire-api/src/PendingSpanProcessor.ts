import type { Context, HrTime, SpanContext } from '@opentelemetry/api'
import { TraceFlags } from '@opentelemetry/api'
import type { IdGenerator, ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY, ATTRIBUTES_SAMPLE_RATE_KEY, ATTRIBUTES_SPAN_TYPE_KEY, INVALID_SPAN_ID } from './constants'
import { isPendingSpanSuppressed } from './pendingSpanSuppression'
import { checkTraceIdRatio } from './sampling'
import { ULIDGenerator } from './ULIDGenerator'

export interface PendingSpanProcessorOptions {
  idGenerator?: IdGenerator
}

export class PendingSpanProcessor implements SpanProcessor {
  private readonly idGenerator: IdGenerator
  private readonly wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor, options: PendingSpanProcessorOptions = {}) {
    this.wrapped = wrapped
    this.idGenerator = options.idGenerator ?? new ULIDGenerator()
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  onEnd(_span: ReadableSpan): void {
    return undefined
  }

  onStart(span: Span, parentContext: Context): void {
    if (isPendingSpanSuppressed(parentContext)) {
      return
    }

    if (!span.isRecording()) {
      return
    }

    const realSpanContext = span.spanContext()
    if ((realSpanContext.traceFlags & TraceFlags.SAMPLED) === 0) {
      return
    }

    const spanType = span.attributes[ATTRIBUTES_SPAN_TYPE_KEY]
    if (spanType !== undefined && spanType !== 'span') {
      return
    }

    const sampleRate = span.attributes[ATTRIBUTES_SAMPLE_RATE_KEY]
    if (typeof sampleRate === 'number' && !checkTraceIdRatio(realSpanContext.traceId, sampleRate)) {
      return
    }

    const pendingSpanContext: SpanContext = {
      isRemote: false,
      spanId: this.idGenerator.generateSpanId(),
      traceFlags: realSpanContext.traceFlags,
      traceId: realSpanContext.traceId,
      ...(realSpanContext.traceState !== undefined ? { traceState: realSpanContext.traceState } : {}),
    }
    const startAndEndTime = span.startTime
    const duration: HrTime = [0, 0]
    const pendingSpan: ReadableSpan = {
      attributes: {
        ...span.attributes,
        [ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY]: span.parentSpanContext?.spanId ?? INVALID_SPAN_ID,
        [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span',
      },
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
      duration,
      ended: true,
      endTime: startAndEndTime,
      events: span.events,
      instrumentationScope: span.instrumentationScope,
      kind: span.kind,
      links: span.links,
      name: span.name,
      parentSpanContext: realSpanContext,
      resource: span.resource,
      spanContext: () => pendingSpanContext,
      startTime: startAndEndTime,
      status: span.status,
    }

    this.wrapped.onEnd(pendingSpan)
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
