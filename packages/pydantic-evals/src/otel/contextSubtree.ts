import { SpanTreeRecordingError } from './errors'
import { SpanNode, SpanTree } from './spanTree'

interface Capture {
  id: string
  spans: CapturedSpan[]
}

const activeCaptures = new Map<string, Capture>()
let captureCounter = 0

interface CapturedSpan {
  attributes: Record<string, unknown>
  endTimestamp: Date
  name: string
  parentSpanId: null | string
  spanId: string
  startTimestamp: Date
  traceId: string
}

interface HrTime {
  0: number
  1: number
}

interface ReadableSpanLike {
  attributes?: Record<string, unknown>
  endTime?: HrTime
  name: string
  parentSpanContext?: null | { spanId: string }
  parentSpanId?: string
  spanContext: () => { spanId: string; traceId: string }
  startTime?: HrTime
}

interface SpanProcessorLike {
  forceFlush: () => Promise<void>
  onEnd: (span: ReadableSpanLike) => void
  onStart: () => void
  shutdown: () => Promise<void>
}

interface TracerProviderLike {
  addSpanProcessor?: (processor: SpanProcessorLike) => void
  getDelegate?: () => TracerProviderLike
}

let exporterInstalled = false
let installError: null | SpanTreeRecordingError = null
let externalProcessorInstalled = false

/**
 * Install a user-provided span processor that forwards spans to the pydantic-evals
 * capture mechanism. Use this when configuring your TracerProvider in v2+ OTel,
 * where `addSpanProcessor` is not available on the provider after construction.
 *
 * Example:
 * ```ts
 * import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
 * import { getSpanTreeProcessor } from '@pydantic/evals'
 * const provider = new BasicTracerProvider({ spanProcessors: [getSpanTreeProcessor()] })
 * ```
 */
export function getSpanTreeProcessor(): SpanProcessorLike {
  externalProcessorInstalled = true
  return {
    async forceFlush(): Promise<void> {
      await Promise.resolve()
    },
    onEnd: (span: ReadableSpanLike) => {
      // Deliver to ALL active captures. This is safe because each evaluation
      // only reads from its own capture, and overlapping captures at the same
      // time legitimately observe the same ambient spans.
      if (activeCaptures.size === 0) return
      const captured = readableSpanToCaptured(span)
      for (const capture of activeCaptures.values()) {
        capture.spans.push(captured)
      }
    },
    onStart: () => {
      // no-op
    },
    async shutdown(): Promise<void> {
      await Promise.resolve()
    },
  }
}

function hrTimeToDate(hrTime: HrTime | undefined): Date {
  if (hrTime === undefined) return new Date()
  return new Date(hrTime[0] * 1000 + hrTime[1] / 1_000_000)
}

function readableSpanToCaptured(span: ReadableSpanLike): CapturedSpan {
  const ctx = span.spanContext()
  const parentId = span.parentSpanContext?.spanId ?? span.parentSpanId ?? null
  return {
    attributes: span.attributes ?? {},
    endTimestamp: hrTimeToDate(span.endTime),
    name: span.name,
    parentSpanId: parentId === '' ? null : parentId,
    spanId: ctx.spanId,
    startTimestamp: hrTimeToDate(span.startTime),
    traceId: ctx.traceId,
  }
}

async function dynamicImport<T>(spec: string): Promise<null | T> {
  try {
    return (await import(/* @vite-ignore */ spec)) as T
  } catch {
    /* v8 ignore next - fallback when OTel is not installed */
    return null
  }
}

async function installExporter(): Promise<null | SpanTreeRecordingError> {
  if (exporterInstalled) return null
  if (externalProcessorInstalled) {
    exporterInstalled = true
    return null
  }
  if (installError !== null) return installError

  const otelApi = await dynamicImport<{ trace: { getTracerProvider: () => TracerProviderLike } }>('@opentelemetry/api')
  if (otelApi === null) {
    installError = new SpanTreeRecordingError(
      'To make use of the `span_tree` in an evaluator, you must install `@opentelemetry/api` and a compatible SDK.'
    )
    return installError
  }

  const provider = otelApi.trace.getTracerProvider()
  const resolved = typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider
  /* v8 ignore next 6 - legacy OTel v1 fallback path; tests use getSpanTreeProcessor */
  if (typeof resolved.addSpanProcessor !== 'function') {
    installError = new SpanTreeRecordingError(
      'To make use of the `span_tree` in an evaluator, you need to configure a TracerProvider with `getSpanTreeProcessor()` before running an evaluation.'
    )
    return installError
  }

  /* v8 ignore next 27 - legacy OTel v1 fallback path; tests use getSpanTreeProcessor */
  const processor: SpanProcessorLike = {
    async forceFlush(): Promise<void> {
      // no-op
      await Promise.resolve()
    },
    onEnd: (span: ReadableSpanLike) => {
      if (activeCaptures.size === 0) return
      const captured = readableSpanToCaptured(span)
      for (const capture of activeCaptures.values()) {
        capture.spans.push(captured)
      }
    },
    onStart: () => {
      // no-op
    },
    async shutdown(): Promise<void> {
      await Promise.resolve()
    },
  }

  resolved.addSpanProcessor(processor)
  exporterInstalled = true
  return null
}

function newCaptureId(): string {
  captureCounter++
  return `capture-${String(captureCounter)}`
}

export async function contextSubtree<T>(fn: (tree: SpanTree | SpanTreeRecordingError) => Promise<T> | T): Promise<T> {
  const error = await installExporter()
  if (error !== null) return await Promise.resolve(fn(error))
  const capture: Capture = { id: newCaptureId(), spans: [] }
  activeCaptures.set(capture.id, capture)
  try {
    return await Promise.resolve(fn(new SpanTree()))
  } finally {
    activeCaptures.delete(capture.id)
  }
}

export async function contextSubtreeCapture<T>(fn: (getTree: () => SpanTree | SpanTreeRecordingError) => Promise<T> | T): Promise<T> {
  const error = await installExporter()
  if (error !== null) return await Promise.resolve(fn(() => error))
  const capture: Capture = { id: newCaptureId(), spans: [] }
  activeCaptures.set(capture.id, capture)
  try {
    return await Promise.resolve(
      fn(() => {
        const nodes = capture.spans.map((s) => new SpanNode({ ...s, attributes: s.attributes as never }))
        return new SpanTree(nodes)
      })
    )
  } finally {
    activeCaptures.delete(capture.id)
  }
}

/** @internal */
export function _resetForTests(): void {
  exporterInstalled = false
  installError = null
  externalProcessorInstalled = false
  activeCaptures.clear()
}
