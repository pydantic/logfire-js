/**
 * Per-task-run in-memory span exporter, gated on a context ID stored under the
 * current `AsyncLocalStorage` context.
 *
 * Each `Dataset.evaluate` case run installs a unique random context ID before
 * the user's task executes; only spans whose ancestry includes that ID get
 * captured. This lets concurrent cases (`maxConcurrency > 1`) keep separate
 * span trees.
 *
 * Mirrors pydantic-evals' `_context_in_memory_span_exporter.py`.
 */

import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { context as ContextAPI, createContextKey, trace as TraceAPI } from '@opentelemetry/api'

import type { SpanTreeRecordingError } from './SpanTree'
import { SpanTree } from './SpanTree'

const CONTEXT_KEY = createContextKey('logfire.evals.exporter_context_id')

interface CaseBucket {
  spans: ReadableSpan[]
}

/**
 * `SpanProcessor` that snapshots ended spans into per-context-id buckets.
 * Each `Dataset.evaluate` case allocates a bucket, runs the user's task with
 * the bucket's ID set on the active OTel context, then drains the bucket and
 * builds a `SpanTree`.
 */
export class EvalsSpanProcessor implements SpanProcessor {
  private readonly buckets = new Map<string, CaseBucket>()

  /** Pop and return the spans captured for a bucket. */
  drainBucket(id: string): ReadableSpan[] {
    const bucket = this.buckets.get(id)
    this.buckets.delete(id)
    return bucket?.spans ?? []
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  onEnd(span: ReadableSpan): void {
    const id = (span as ReadableSpan & { [EXPORTER_ID_SYMBOL]?: string })[EXPORTER_ID_SYMBOL]
    if (id === undefined) {
      return
    }
    const bucket = this.buckets.get(id)
    if (bucket === undefined) {
      return
    }
    bucket.spans.push(span)
  }

  // The processor needs to receive `onStart` to capture the parent context's
  // exporter ID at span start (since by `onEnd` the active context may have
  // changed). We stash the ID on the span via a non-enumerable symbol so it
  // survives until export.
  onStart(span: ReadableSpan, parentContext: Context): void {
    const id = parentContext.getValue(CONTEXT_KEY) as string | undefined
    if (id !== undefined) {
      Object.defineProperty(span, EXPORTER_ID_SYMBOL, { configurable: true, enumerable: false, value: id, writable: true })
    }
  }

  /** Allocate a fresh bucket and return its ID. */
  openBucket(id: string): void {
    this.buckets.set(id, { spans: [] })
  }

  /** Wrap `fn` in a context that carries `bucketId`, so any spans started inside are captured. */
  runWithBucket<R>(bucketId: string, fn: () => Promise<R> | R): Promise<R> | R {
    const ctx = ContextAPI.active().setValue(CONTEXT_KEY, bucketId)
    return ContextAPI.with(ctx, fn)
  }

  async shutdown(): Promise<void> {
    this.buckets.clear()
    return Promise.resolve()
  }
}

const EXPORTER_ID_SYMBOL = Symbol.for('logfire.evals.exporterId')

let singleton: EvalsSpanProcessor | null = null

/**
 * Get the singleton evals span processor. Pass it to a custom `TracerProvider`
 * via `addSpanProcessor(getEvalsSpanProcessor())` if you're not using `logfire.configure()`.
 */
export function getEvalsSpanProcessor(): EvalsSpanProcessor {
  singleton ??= new EvalsSpanProcessor()
  return singleton
}

/** Build a `SpanTree` for a drained bucket, or return one carrying a recording error. */
export function buildSpanTree(spans: ReadableSpan[], recordingError: null | SpanTreeRecordingError): SpanTree {
  if (recordingError !== null) {
    return SpanTree.fromError(recordingError)
  }
  return SpanTree.fromSpans(spans)
}

/**
 * Best-effort detection of whether the active TracerProvider can record spans.
 * If the provider is not the default no-op/proxy provider, assume callers wired
 * the evals processor or another recording provider.
 */
export function isProcessorInstalledOnGlobal(): boolean {
  const tp = TraceAPI.getTracerProvider()
  return typeof tp === 'object' && tp.constructor.name !== 'NoopTracerProvider' && tp.constructor.name !== 'ProxyTracerProvider'
}
