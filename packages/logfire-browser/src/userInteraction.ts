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
 *
 * The instrumentation ends the span when the first listener returns, and never when it throws. The
 * first listener is often a library's capture listener, such as the replay recorder's, so the span
 * would end before the application's handler starts its work. Tail sampling then decides the trace
 * without that work. The span ends instead one task later, at the time the last listener returned.
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
    const listenerEnds = new WeakMap<Span, () => void>()
    let warnedCreateSpanError = false
    internals._createSpan = (element, eventName, parentSpan) => {
      if (parentSpan !== undefined && internals._isEnabled !== false) {
        const listenerSpan = trace.wrapSpanContext(parentSpan.spanContext())
        // The instrumentation passes the span returned for the previous listener, so each listener
        // span carries the recorder on to the next one.
        const recordListenerEnd = listenerEnds.get(parentSpan)
        if (recordListenerEnd !== undefined) {
          listenerSpan.end = recordListenerEnd
          listenerEnds.set(listenerSpan, recordListenerEnd)
        }
        return listenerSpan
      }
      let span: Span | undefined
      try {
        span = createSpan.call(instrumentation, element, eventName, parentSpan)
      } catch (error) {
        // The instrumentation reads `localName` up the tree for the target's XPath outside its own
        // try. Firefox throws `Permission denied to access property "localName"` for a node that the
        // page script cannot access, such as one a browser extension inserted. Without a span the
        // instrumentation runs the listener untraced.
        if (!warnedCreateSpanError) {
          warnedCreateSpanError = true
          diag.warn('logfire-browser: the user interaction instrumentation could not create a span; skipping the event', error)
        }
        return undefined
      }
      if (span !== undefined && internals._isEnabled !== false && !isZoneAvailable()) {
        listenerEnds.set(span, endAfterDispatch(span))
      }
      return span
    }
  }
}

function endAfterDispatch(span: Span): () => void {
  const end = span.end.bind(span)
  let lastListenerEnd: number | undefined
  const recordListenerEnd = () => {
    lastListenerEnd = performance.now()
  }
  span.end = recordListenerEnd
  setTimeout(() => {
    end(lastListenerEnd)
  }, 0)
  return recordListenerEnd
}

// With Zone.js, the instrumentation ends the span itself once the zone's tasks complete.
function isZoneAvailable(): boolean {
  return typeof window !== 'undefined' && (window as { Zone?: unknown }).Zone !== undefined
}
