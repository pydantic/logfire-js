/**
 * Internal helpers for opening spans on the `pydantic-evals` OTel scope while
 * reusing logfire-js's formatter, scrubber, and JSON-schema-aware attribute
 * serializer.
 *
 * Petyo's review of #104 flagged hand-rolled formatting and JSON-schema
 * synthesis as a regression vs. the existing logfire-js infra. This module is
 * the seam: it goes through `logfireFormatWithExtras` and `serializeAttributes`
 * exactly the same way the public `span()` / `startSpan()` do.
 */

import type { Span, Tracer } from '@opentelemetry/api'

import { context as ContextAPI, trace as TraceAPI } from '@opentelemetry/api'

import {
  ATTRIBUTES_LEVEL_KEY,
  ATTRIBUTES_MESSAGE_KEY,
  ATTRIBUTES_MESSAGE_TEMPLATE_KEY,
  ATTRIBUTES_SPAN_TYPE_KEY,
  ATTRIBUTES_TAGS_KEY,
} from '../constants'
import { logfireFormatWithExtras } from '../formatter'
import { logfireApiConfig } from '../logfireApiConfig'
import { serializeAttributes } from '../serializeAttributes'
import { EVALS_OTEL_SCOPE } from './constants'

// Logfire `info` level — duplicated here to avoid importing the barrel index.ts
// (which would create a cycle once the evals barrel is re-exported).
const LEVEL_INFO = 9

// Don't cache — `getTracer()` returns a ProxyTracer that delegates to the
// current global provider. Caching would break if the provider is swapped
// (e.g. between tests).
function getEvalsTracer(): Tracer {
  return TraceAPI.getTracer(EVALS_OTEL_SCOPE)
}

interface EvalsSpanOptions {
  attributes?: Record<string, unknown>
  level?: number
  parentSpan?: Span
  /** Stable OTel span name, distinct from the friendly `msgTemplate`. */
  spanName?: string
  spanType?: 'log' | 'span'
  tags?: string[]
}

/**
 * Start a span on the `pydantic-evals` scope. Run a callback in its active
 * context, end the span on completion (handles thrown errors and rejected
 * promises) and return the callback's result.
 */
export function evalsSpan<R>(msgTemplate: string, opts: EvalsSpanOptions, callback: (span: Span) => R): R {
  const attributes = opts.attributes ?? {}
  const level = opts.level ?? LEVEL_INFO
  const tags = opts.tags ?? []
  const spanType = opts.spanType ?? 'span'

  const { extraAttributes, formattedMessage, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)

  const ctx = opts.parentSpan ? TraceAPI.setSpan(ContextAPI.active(), opts.parentSpan) : ContextAPI.active()

  return getEvalsTracer().startActiveSpan(
    opts.spanName ?? msgTemplate,
    {
      attributes: {
        ...serializeAttributes({ ...attributes, ...extraAttributes }),
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_MESSAGE_KEY]: formattedMessage,
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: newTemplate,
        [ATTRIBUTES_SPAN_TYPE_KEY]: spanType,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
      },
    },
    ctx,
    (span: Span) => {
      let result: R
      try {
        result = callback(span)
      } catch (err) {
        recordExceptionOnSpan(span, err)
        span.end()
        throw err
      }
      if (result instanceof Promise) {
        // We can't return synchronously here because the promise chain captures
        // the span's lifetime. Cast through unknown to satisfy TS — the caller
        // already knows R is a Promise type.
        return (result as Promise<unknown>).then(
          (v: unknown) => {
            span.end()
            return v
          },
          (err: unknown) => {
            recordExceptionOnSpan(span, err)
            span.end()
            throw err
          }
        ) as R
      }
      span.end()
      return result
    }
  )
}

/**
 * Set additional attributes on an already-open span, going through the same
 * serializer the platform expects (so JSON-schema sidecar attributes get added).
 */
export function setEvalsSpanAttributes(span: Span, attributes: Record<string, unknown>): void {
  const serialized = serializeAttributes(attributes)
  for (const [k, v] of Object.entries(serialized)) {
    span.setAttribute(k, v)
  }
}

function recordExceptionOnSpan(span: Span, err: unknown): void {
  if (err instanceof Error) {
    span.recordException(err)
  } else {
    span.recordException(String(err))
  }
}
