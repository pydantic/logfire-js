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
// Runs to the next whitespace because a query string can contain parentheses and apostrophes.
const TEXT_URL_PATTERN = /https?:\/\/[^\s"<>`]+/giu
// Stack frames append `:line:column` to the script URL, and Chrome wraps the location in parentheses.
const LOCATION_SUFFIX_PATTERN = /:\d+:\d+\)?$/u
// A V8 frame line starts with `at`; Firefox and Safari frames put `@` right before the URL.
const V8_FRAME_LINE_PATTERN = /^\s*at\s/u

// The location is kept only on a stack-frame line, so digits that end a query value elsewhere,
// such as in a message, are not restored after the query is removed.
function urlTextSuffix(match: string, isFrame: boolean): string {
  const location = isFrame ? LOCATION_SUFFIX_PATTERN.exec(match)?.[0] : undefined
  return location ?? closingPunctuation(match)
}

// Closing parentheses and quotes around a URL in prose are kept as punctuation. Scanned backwards
// rather than with an unanchored regex, which retries a long run from every position.
function closingPunctuation(match: string): string {
  let start = match.length
  while (start > 0 && (match[start - 1] === ')' || match[start - 1] === "'")) {
    start--
  }
  return match.slice(start)
}

// A suffix rule rather than a fixed list, so a new URL attribute such as `web_vital.lcp.url` cannot
// skip sanitization by omission.
function isUrlAttribute(key: string): boolean {
  return URL_ATTRIBUTE_KEYS.has(key) || key.endsWith('.url')
}

/** Remove credentials, queries, and fragments from every HTTP URL in a stack trace or message. */
export function sanitizeUrlsInText(text: string): string {
  // Line by line, so deciding whether a URL sits in a stack frame never rescans earlier text.
  return text
    .split('\n')
    .map((line) => {
      const isV8Frame = V8_FRAME_LINE_PATTERN.test(line)
      return line.replace(TEXT_URL_PATTERN, (match: string, offset: number) => {
        const suffix = urlTextSuffix(match, isV8Frame || line[offset - 1] === '@')
        return `${sanitizeUrl(match.slice(0, match.length - suffix.length))}${suffix}`
      })
    })
    .join('\n')
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
    // The export pass leaves URL attributes to this policy, so links must be covered here too.
    for (const link of span.links) {
      if (link.attributes !== undefined) {
        sanitizeAttributes(link.attributes)
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
