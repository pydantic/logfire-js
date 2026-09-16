import type { Attributes, Context } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-web'

function sanitizeUrl(value: string): string {
  try {
    // A fixed base lets URL parse relative targets and protocol-relative URLs without
    // depending on the current page. Rebuilding from origin/pathname omits credentials.
    const base = 'https://logfire.invalid'
    let url: URL
    let absolute = true
    try {
      url = new URL(value)
    } catch {
      absolute = false
      url = new URL(value, base)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '[REDACTED]'
    }
    const origin = absolute || url.origin !== base ? url.origin : ''
    return `${origin}${url.pathname}`
  } catch {
    return '[REDACTED]'
  }
}

function sanitizeAttributes(attributes: Attributes): void {
  for (const key of ['http.url', 'url.full', 'http.target', 'http.referrer']) {
    const value = attributes[key]
    if (typeof value === 'string') {
      attributes[key] = sanitizeUrl(value)
    } else if (value !== undefined) {
      Reflect.deleteProperty(attributes, key)
    }
  }
  Reflect.deleteProperty(attributes, 'url.query')
  Reflect.deleteProperty(attributes, 'url.fragment')
}

/** Remove URL credentials, queries, and fragments before downstream processors export them. */
export class BrowserUrlSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    sanitizeAttributes(span.attributes)
  }

  onEnd(span: ReadableSpan): void {
    // Instrumentations can add request URLs and resource timing events after onStart.
    sanitizeAttributes(span.attributes)
    for (const event of span.events) {
      if (event.attributes !== undefined) {
        sanitizeAttributes(event.attributes)
      }
    }
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
