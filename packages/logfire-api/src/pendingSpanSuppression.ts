import type { Context } from '@opentelemetry/api'
import { createContextKey } from '@opentelemetry/api'

const PENDING_SPAN_SUPPRESSED_CONTEXT_KEY = createContextKey('logfire.suppress_pending_span')

export function setPendingSpanSuppressed(context: Context): Context {
  return context.setValue(PENDING_SPAN_SUPPRESSED_CONTEXT_KEY, true)
}

export function isPendingSpanSuppressed(context: Context): boolean {
  return context.getValue(PENDING_SPAN_SUPPRESSED_CONTEXT_KEY) === true
}
