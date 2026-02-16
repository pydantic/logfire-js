import { Context, HrTime } from '@opentelemetry/api'
import { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { checkTraceIdRatio, SpanLevel, type TailSamplingSpanInfo } from './sampling'

interface BufferedSpan {
  context: Context | null
  event: 'end' | 'start'
  span: ReadableSpan | Span
}

interface TraceBuffer {
  spans: BufferedSpan[]
  startTime: HrTime
}

// Sentinel value indicating a buffer was already flushed
const FLUSHED = Symbol('flushed')

type TailCallback = (spanInfo: TailSamplingSpanInfo) => number

function hrTimeToSeconds(hrTime: HrTime): number {
  return hrTime[0] + hrTime[1] / 1e9
}

export class TailSamplingProcessor implements SpanProcessor {
  private buffers = new Map<string, TraceBuffer | typeof FLUSHED>()
  private tail: TailCallback
  private wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor, tail: TailCallback) {
    this.wrapped = wrapped
    this.tail = tail
  }

  async forceFlush(): Promise<void> {
    return this.wrapped.forceFlush()
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId
    const entry = this.buffers.get(traceId)

    if (entry === FLUSHED) {
      this.wrapped.onEnd(span)
      return
    }

    if (!entry) {
      this.wrapped.onEnd(span)
      return
    }

    entry.spans.push({ context: null, event: 'end', span })

    const isRoot = !span.parentSpanContext
    if (isRoot) {
      // Root span ended — check one last time, then discard if still buffered
      if (!this.checkSpan(span, null, 'end', entry)) {
        this.buffers.delete(traceId)
      }
      return
    }

    this.checkSpan(span, null, 'end', entry)
  }

  onStart(span: Span, parentContext: Context): void {
    const traceId = span.spanContext().traceId
    const entry = this.buffers.get(traceId)

    if (entry === FLUSHED) {
      this.wrapped.onStart(span, parentContext)
      return
    }

    const readable = span as unknown as ReadableSpan
    const isRoot = !readable.parentSpanContext
    if (isRoot && !entry) {
      const buffer: TraceBuffer = { spans: [], startTime: readable.startTime }
      this.buffers.set(traceId, buffer)
      buffer.spans.push({ context: parentContext, event: 'start', span })
      this.checkSpan(span as unknown as ReadableSpan, parentContext, 'start', buffer)
      return
    }

    if (entry) {
      entry.spans.push({ context: parentContext, event: 'start', span })
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

  private checkSpan(span: ReadableSpan, context: Context | null, event: 'end' | 'start', buffer: TraceBuffer): boolean {
    const duration = hrTimeToSeconds(span.startTime) - hrTimeToSeconds(buffer.startTime)
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

    for (const { context, event, span } of buffer.spans) {
      if (event === 'start') {
        // context is always set for 'start' events
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.wrapped.onStart(span as Span, context!)
      } else {
        this.wrapped.onEnd(span as ReadableSpan)
      }
    }
  }
}
