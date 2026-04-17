/**
 * Internal span creation helper. Emits OTel spans for `Dataset.evaluate`, each case,
 * each task, and each evaluator run - so users who configure a TracerProvider (e.g.
 * via logfire.configure()) see a hierarchical trace of their evaluation.
 *
 * If @opentelemetry/api isn't installed or a noop tracer is active, this degrades
 * to calling the callback directly with a no-op span.
 */

interface SpanLike {
  end: () => void
  recordException: (err: unknown) => void
  setAttribute: (k: string, v: unknown) => void
  setAttributes: (attrs: Record<string, unknown>) => void
  setStatus: (s: { code: number; message?: string }) => void
}

interface TracerLike {
  startActiveSpan: <R>(name: string, opts: { attributes?: Record<string, unknown> }, fn: (span: SpanLike) => R) => R
}

let tracer: null | TracerLike = null
let tracerLoadAttempted = false

async function getTracer(): Promise<null | TracerLike> {
  if (tracer !== null) return tracer
  if (tracerLoadAttempted) return null
  tracerLoadAttempted = true
  try {
    const api = (await import('@opentelemetry/api')) as {
      trace: { getTracer: (n: string) => TracerLike }
    }
    tracer = api.trace.getTracer('pydantic-evals')
    return tracer
  } catch {
    /* v8 ignore next - fallback when OTel API is not installed */
    return null
  }
}

const ATTR_MSG_TEMPLATE = 'logfire.msg_template'
const ATTR_MSG = 'logfire.msg'
const ATTR_SPAN_TYPE = 'logfire.span_type'

function formatMessage(template: string, attrs: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = attrs[key]
    if (v === undefined) return `{${key}}`
    if (typeof v === 'string') return v
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  })
}

function normalizeAttribute(v: unknown): unknown {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function normalizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = normalizeAttribute(v)
  }
  return out
}

export async function evalSpan<R>(
  messageTemplate: string,
  attrs: Record<string, unknown>,
  fn: (span: SpanLike) => Promise<R> | R
): Promise<R> {
  const t = await getTracer()
  const enrichedAttrs: Record<string, unknown> = {
    ...normalizeAttributes(attrs),
    [ATTR_MSG]: formatMessage(messageTemplate, attrs),
    [ATTR_MSG_TEMPLATE]: messageTemplate,
    [ATTR_SPAN_TYPE]: 'span',
  }
  if (t === null) {
    /* v8 ignore next 8 - exercised only when @opentelemetry/api is unavailable */
    const noop: SpanLike = {
      end: () => {
        /* noop */
      },
      recordException: () => {
        /* noop */
      },
      setAttribute: () => {
        /* noop */
      },
      setAttributes: () => {
        /* noop */
      },
      setStatus: () => {
        /* noop */
      },
    }
    return await Promise.resolve(fn(noop))
  }
  return await t.startActiveSpan(messageTemplate, { attributes: enrichedAttrs }, async (span) => {
    try {
      const result = await Promise.resolve(fn(span))
      span.end()
      return result
    } catch (err) {
      span.recordException(err)
      span.setStatus({ code: 2, message: (err as Error).message })
      span.end()
      throw err
    }
  })
}

/** @internal */
export function _resetTracerForTests(): void {
  tracer = null
  tracerLoadAttempted = false
}
