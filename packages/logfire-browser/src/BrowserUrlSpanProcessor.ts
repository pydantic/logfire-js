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

const URL_ATTRIBUTE_KEYS = new Set(['http.url', 'url.full', 'http.target', 'http.referrer'])
const ATTR_EXCEPTION_STACKTRACE = 'exception.stacktrace'
// Runs to the next whitespace because a query string can contain parentheses.
const TEXT_URL_PATTERN = /https?:\/\/[^\s"'<>`]+/giu
// Stack frames append `:line:column` to the script URL, and Chrome wraps the location in parentheses.
// Only a full line and column pair is kept, so digits that end a query value are not restored.
const URL_TEXT_SUFFIX_PATTERN = /:\d+:\d+\)?$|\)$/u

// A suffix rule rather than a fixed list, so a new URL attribute such as `web_vital.lcp.url` cannot
// skip sanitization by omission.
function isUrlAttribute(key: string): boolean {
  return URL_ATTRIBUTE_KEYS.has(key) || key.endsWith('.url')
}

/** Remove credentials, queries, and fragments from every HTTP URL in a stack trace or message. */
export function sanitizeUrlsInText(text: string): string {
  return text.replace(TEXT_URL_PATTERN, (match) => {
    const suffix = URL_TEXT_SUFFIX_PATTERN.exec(match)?.[0] ?? ''
    return `${sanitizeUrl(match.slice(0, match.length - suffix.length))}${suffix}`
  })
}

function sanitizeAttributes(attributes: Attributes): void {
  for (const key of Object.keys(attributes)) {
    if (!isUrlAttribute(key)) {
      continue
    }
    const value = attributes[key]
    if (typeof value === 'string') {
      attributes[key] = sanitizeUrl(value)
    } else if (value !== undefined) {
      Reflect.deleteProperty(attributes, key)
    }
  }
  const stacktrace = attributes[ATTR_EXCEPTION_STACKTRACE]
  if (typeof stacktrace === 'string') {
    attributes[ATTR_EXCEPTION_STACKTRACE] = sanitizeUrlsInText(stacktrace)
  }
  Reflect.deleteProperty(attributes, 'url.query')
  Reflect.deleteProperty(attributes, 'url.fragment')
}

/** Remove URL credentials, queries, and fragments, including those in stack traces, before downstream processors export them. */
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
