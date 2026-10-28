export function matchesUrlPatterns(url: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(url))
}

export function redactUrl(url: string, patterns: readonly RegExp[], baseUrl: string): string {
  if (!matchesUrlPatterns(url, patterns)) {
    return url
  }

  try {
    const parsed = new URL(url, baseUrl)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    const [withoutQuery = url] = url.split('?')
    const [withoutHash = withoutQuery] = withoutQuery.split('#')
    return withoutHash
  }
}

// Runs to the next whitespace because a query string can contain parentheses.
const TEXT_URL_PATTERN = /https?:\/\/[^\s"'<>`]+/giu
// Stack frames append `:line:column` to the script URL, and Chrome wraps the location in parentheses.
const LOCATION_SUFFIX_PATTERN = /:\d+:\d+\)?$/u
const CLOSING_PARENTHESIS_PATTERN = /\)$/u
// A V8 frame line starts with `at`; Firefox and Safari frames put `@` right before the URL.
const STACK_FRAME_PREFIX_PATTERN = /^\s*at\s|@$/u

// The location is kept only on a stack-frame line, so digits that end a query value elsewhere,
// such as in a message, are not restored after the query is removed.
function urlTextSuffix(match: string, offset: number, text: string): string {
  const prefix = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset)
  const location = STACK_FRAME_PREFIX_PATTERN.test(prefix) ? LOCATION_SUFFIX_PATTERN.exec(match)?.[0] : undefined
  return location ?? CLOSING_PARENTHESIS_PATTERN.exec(match)?.[0] ?? ''
}

/** Redact each HTTP URL inside free text, such as a stack trace, that matches `patterns`. */
export function redactUrlsInText(text: string, patterns: readonly RegExp[], baseUrl: string): string {
  if (patterns.length === 0) {
    return text
  }
  return text.replace(TEXT_URL_PATTERN, (match: string, offset: number) => {
    const suffix = urlTextSuffix(match, offset, text)
    return `${redactUrl(match.slice(0, match.length - suffix.length), patterns, baseUrl)}${suffix}`
  })
}
