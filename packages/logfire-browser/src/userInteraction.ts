/* eslint-disable no-underscore-dangle -- The fix overrides private members of the upstream user interaction instrumentation. */
import type { Span } from '@opentelemetry/api'
import { diag, trace } from '@opentelemetry/api'

import type { Instrumentation } from '@opentelemetry/instrumentation'

const USER_INTERACTION_INSTRUMENTATION = '@opentelemetry/instrumentation-user-interaction'

type CreateSpan = (element: unknown, eventName: string, parentSpan?: Span) => Span | undefined

interface UserInteractionInternals {
  _createSpan?: CreateSpan
  _isEnabled?: boolean
}

/**
 * Without Zone.js, the user interaction instrumentation creates one span for each listener that an
 * event reaches, and it parents each span to the span of the previous listener for that event. One
 * click then becomes a chain of identical click spans. The instrumentation passes the previous span
 * only for the same event, so this keeps the first span and runs every later listener in a
 * non-recording span with the same context. Work that a later listener starts stays a child of the
 * one click span. https://github.com/open-telemetry/opentelemetry-browser/issues/22
 */
export function collapseUserInteractionSpans(instrumentations: readonly Instrumentation[]): void {
  for (const instrumentation of instrumentations) {
    if (instrumentation.instrumentationName !== USER_INTERACTION_INSTRUMENTATION) {
      continue
    }
    const internals = instrumentation as unknown as UserInteractionInternals
    const createSpan = internals._createSpan
    if (typeof createSpan !== 'function') {
      diag.warn('logfire-browser: the user interaction instrumentation has no _createSpan; it can export one span per event listener')
      continue
    }
    internals._createSpan = (element, eventName, parentSpan) => {
      if (parentSpan !== undefined && internals._isEnabled !== false) {
        return trace.wrapSpanContext(parentSpan.spanContext())
      }
      return createSpan.call(instrumentation, element, eventName, parentSpan)
    }
  }
}
