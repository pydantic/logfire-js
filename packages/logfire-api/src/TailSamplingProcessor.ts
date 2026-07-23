import type { Context, HrTime } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { checkTraceIdRatio, SpanLevel } from './sampling'
import type { TailSamplingSpanInfo } from './sampling'

interface BufferedEndEvent {
  index: number
  kind: 'end'
}

interface BufferedStart {
  context: Context
  span: Span
}

interface BufferedStartEvent {
  index: number
  kind: 'start'
}

interface TraceBuffer {
  ended: ReadableSpan[]
  events: (BufferedEndEvent | BufferedStartEvent)[]
  started: BufferedStart[]
  startTime: HrTime
}

// Sentinel value indicating a buffer was already flushed
const FLUSHED = Symbol('flushed')

type TailCallback = (spanInfo: TailSamplingSpanInfo) => number

export interface TailSamplingProcessorOptions {
  deferredProcessor?: SpanProcessor
}

function hrTimeToSeconds(hrTime: HrTime): number {
  return hrTime[0] + hrTime[1] / 1e9
}

export class TailSamplingProcessor implements SpanProcessor {
  private readonly buffers = new Map<string, TraceBuffer | typeof FLUSHED>()
  private readonly deferredProcessor: SpanProcessor | undefined
  private readonly tail: TailCallback
  private readonly wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor, tail: TailCallback, options: TailSamplingProcessorOptions = {}) {
    this.wrapped = wrapped
    this.tail = tail
    this.deferredProcessor = options.deferredProcessor
  }

  async forceFlush(): Promise<void> {
    return this.wrapped.forceFlush()
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId
    const entry = this.buffers.get(traceId)

    if (entry === FLUSHED) {
      this.wrapped.onEnd(span)
      this.deferredProcessor?.onEnd(span)
      if (!span.parentSpanContext) {
        this.buffers.delete(traceId)
      }
      return
    }

    if (!entry) {
      this.wrapped.onEnd(span)
      return
    }

    const endIndex = entry.ended.push(span) - 1
    entry.events.push({ index: endIndex, kind: 'end' })

    const isRoot = !span.parentSpanContext
    if (isRoot) {
      // Root span ended — check one last time, then discard the trace state.
      this.checkSpan(span, null, 'end', entry)
      this.buffers.delete(traceId)
      return
    }

    this.checkSpan(span, null, 'end', entry)
  }

  onStart(span: Span, parentContext: Context): void {
    const traceId = span.spanContext().traceId
    const entry = this.buffers.get(traceId)

    if (entry === FLUSHED) {
      this.wrapped.onStart(span, parentContext)
      this.deferredProcessor?.onStart(span, parentContext)
      return
    }

    const readable = span as unknown as ReadableSpan
    const isRoot = !readable.parentSpanContext
    if (isRoot && !entry) {
      const buffer: TraceBuffer = { ended: [], events: [], started: [], startTime: readable.startTime }
      this.buffers.set(traceId, buffer)
      this.addStart(buffer, span, parentContext)
      this.checkSpan(span as unknown as ReadableSpan, parentContext, 'start', buffer)
      return
    }

    if (entry) {
      this.addStart(entry, span, parentContext)
      this.checkSpan(span as unknown as ReadableSpan, parentContext, 'start', entry)
      return
    }

    // No buffer and not root — trace started before this processor was active
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    this.buffers.clear()
    return this.wrapped.shutdown()
  }

  private addStart(buffer: TraceBuffer, span: Span, context: Context): void {
    const startIndex = buffer.started.push({ context, span }) - 1
    buffer.events.push({ index: startIndex, kind: 'start' })
  }

  private checkSpan(span: ReadableSpan, context: Context | null, event: 'end' | 'start', buffer: TraceBuffer): boolean {
    if (span.attributes[ATTRIBUTES_SPAN_TYPE_KEY] === 'pending_span') {
      return false
    }

    // Match Python logfire: duration runs from the trace start to the start or end of this span,
    // depending on which event is being checked.
    const spanTime = event === 'end' ? span.endTime : span.startTime
    const duration = hrTimeToSeconds(spanTime) - hrTimeToSeconds(buffer.startTime)
    const level = SpanLevel.fromSpan(span)

    const info: TailSamplingSpanInfo = { context, duration, event, level, span }
    const rate = this.tail(info)

    if (rate >= 1.0 || (rate > 0.0 && checkTraceIdRatio(span.spanContext().traceId, rate))) {
      this.flushBuffer(span.spanContext().traceId, buffer)
      return true
    }

    return false
  }

  private flushBuffer(traceId: string, buffer: TraceBuffer): void {
    this.buffers.set(traceId, FLUSHED)

    for (const event of buffer.events) {
      if (event.kind === 'start') {
        const started = buffer.started[event.index]
        if (started === undefined) {
          throw new Error('missing buffered span start event')
        }
        const { context, span } = started
        this.wrapped.onStart(span, context)
        this.deferredProcessor?.onStart(span, context)
      } else {
        const span = buffer.ended[event.index]
        if (span === undefined) {
          throw new Error('missing buffered span end event')
        }
        this.wrapped.onEnd(span)
        this.deferredProcessor?.onEnd(span)
      }
    }
  }
}
