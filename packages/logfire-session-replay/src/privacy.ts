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
// Only a full line and column pair is kept, so digits that end a query value are not restored.
const URL_TEXT_SUFFIX_PATTERN = /:\d+:\d+\)?$|\)$/u

/** Redact each HTTP URL inside free text, such as a stack trace, that matches `patterns`. */
export function redactUrlsInText(text: string, patterns: readonly RegExp[], baseUrl: string): string {
  if (patterns.length === 0) {
    return text
  }
  return text.replace(TEXT_URL_PATTERN, (match) => {
    const suffix = URL_TEXT_SUFFIX_PATTERN.exec(match)?.[0] ?? ''
    return `${redactUrl(match.slice(0, match.length - suffix.length), patterns, baseUrl)}${suffix}`
  })
}
