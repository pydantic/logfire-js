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
  /** Set once the trace was sampled and its buffered events were replayed. */
  flushed: boolean
  /** Started spans that have not ended yet, including the root. */
  outstanding: number
  rootEnded: boolean
  started: BufferedStart[]
  startTime: HrTime
}

type TailCallback = (spanInfo: TailSamplingSpanInfo) => number

export interface TailSamplingProcessorOptions {
  deferredProcessor?: SpanProcessor
}

function hrTimeToSeconds(hrTime: HrTime): number {
  return hrTime[0] + hrTime[1] / 1e9
}

/**
 * Cap on traces held past their root's end because spans are still open. A span
 * that never ends would otherwise pin its trace forever.
 */
const MAX_TRACES_RETAINED_AFTER_ROOT = 1000

export class TailSamplingProcessor implements SpanProcessor {
  private readonly buffers = new Map<string, TraceBuffer>()
  /** Traces still held after their root ended, in insertion order for eviction. */
  private readonly retainedAfterRoot = new Set<string>()
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

    if (entry === undefined) {
      this.wrapped.onEnd(span)
      return
    }

    entry.outstanding -= 1
    if (!span.parentSpanContext) {
      entry.rootEnded = true
    }

    if (entry.flushed) {
      this.wrapped.onEnd(span)
      this.deferredProcessor?.onEnd(span)
    } else {
      const endIndex = entry.ended.push(span) - 1
      entry.events.push({ index: endIndex, kind: 'end' })
      this.checkSpan(span, null, 'end', entry)
    }

    // Keep the trace's state until the root has ended and every started span has
    // ended. Releasing it at root end let a later span fall through to the
    // unbuffered path, which exports unconditionally.
    if (entry.rootEnded && entry.outstanding <= 0) {
      this.buffers.delete(traceId)
      this.retainedAfterRoot.delete(traceId)
    } else if (entry.rootEnded) {
      this.retainAfterRoot(traceId)
    }
  }

  onStart(span: Span, parentContext: Context): void {
    const traceId = span.spanContext().traceId
    const entry = this.buffers.get(traceId)
    const readable = span as unknown as ReadableSpan

    if (entry !== undefined) {
      entry.outstanding += 1
      if (entry.flushed) {
        this.wrapped.onStart(span, parentContext)
        this.deferredProcessor?.onStart(span, parentContext)
        return
      }
      this.addStart(entry, span, parentContext)
      this.checkSpan(readable, parentContext, 'start', entry)
      return
    }

    if (!readable.parentSpanContext) {
      const buffer: TraceBuffer = {
        ended: [],
        events: [],
        flushed: false,
        outstanding: 1,
        rootEnded: false,
        started: [],
        startTime: readable.startTime,
      }
      this.buffers.set(traceId, buffer)
      this.addStart(buffer, span, parentContext)
      this.checkSpan(readable, parentContext, 'start', buffer)
      return
    }

    // No buffer and not root — trace started before this processor was active
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    this.buffers.clear()
    this.retainedAfterRoot.clear()
    return this.wrapped.shutdown()
  }

  private retainAfterRoot(traceId: string): void {
    if (this.retainedAfterRoot.has(traceId)) {
      return
    }
    this.retainedAfterRoot.add(traceId)
    if (this.retainedAfterRoot.size <= MAX_TRACES_RETAINED_AFTER_ROOT) {
      return
    }
    const oldest = this.retainedAfterRoot.values().next().value
    if (oldest !== undefined) {
      this.retainedAfterRoot.delete(oldest)
      this.buffers.delete(oldest)
    }
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
      this.flushBuffer(buffer)
      return true
    }

    return false
  }

  private flushBuffer(buffer: TraceBuffer): void {
    buffer.flushed = true

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

    // Replayed events are never read again, so release them rather than hold
    // them for as long as the trace stays open.
    buffer.ended = []
    buffer.events = []
    buffer.started = []
  }
}
