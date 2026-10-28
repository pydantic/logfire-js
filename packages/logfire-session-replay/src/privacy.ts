export function matchesUrlPatterns(url: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(url))
}

export function redactUrl(url: string, patterns: readonly RegExp[], baseUrl: string): string {
  return matchesUrlPatterns(url, patterns) ? stripQueryAndFragment(url, baseUrl) : url
}

function stripQueryAndFragment(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url, baseUrl)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    const [withoutQuery = url] = url.split('?')
    const [withoutHash = withoutQuery] = withoutQuery.split('#')
    return withoutHash
  }
}

// Runs to the next whitespace because a query string can contain parentheses and apostrophes.
const TEXT_URL_PATTERN = /https?:\/\/[^\s"<>`]+/giu
// Stack frames append `:line:column` to the script URL, and Chrome wraps the location in parentheses.
const LOCATION_SUFFIX_PATTERN = /:\d+:\d+\)?$/u
// Text such as `?next=https://...` holds a URL inside another URL's match.
const EMBEDDED_URL_BOUNDARY_PATTERN = /(?=https?:\/\/)/iu
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

// Each embedded URL is tested on its own, so a pattern anchored to the start of a private URL still
// matches it. Removing the outer query and fragment also removes the embedded URL they carry.
function redactTextUrl(url: string, patterns: readonly RegExp[], baseUrl: string): string {
  const matches =
    matchesUrlPatterns(url, patterns) || url.split(EMBEDDED_URL_BOUNDARY_PATTERN).some((embedded) => matchesUrlPatterns(embedded, patterns))
  return matches ? stripQueryAndFragment(url, baseUrl) : url
}

/** Redact each HTTP URL inside free text, such as a stack trace, that matches `patterns`. */
export function redactUrlsInText(text: string, patterns: readonly RegExp[], baseUrl: string): string {
  if (patterns.length === 0) {
    return text
  }
  // Line by line, so deciding whether a URL sits in a stack frame never rescans earlier text.
  return text
    .split('\n')
    .map((line) => {
      const isV8Frame = V8_FRAME_LINE_PATTERN.test(line)
      return line.replace(TEXT_URL_PATTERN, (match: string, offset: number) => {
        const suffix = urlTextSuffix(match, isV8Frame || line[offset - 1] === '@')
        return `${redactTextUrl(match.slice(0, match.length - suffix.length), patterns, baseUrl)}${suffix}`
      })
    })
    .join('\n')
}
