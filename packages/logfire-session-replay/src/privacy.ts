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
