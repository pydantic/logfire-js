export type TelemetryUrlKind = 'exact' | 'replay-base'

export interface TelemetryUrl {
  kind: TelemetryUrlKind
  url: string
}

/**
 * Build patterns for the URL forms used by browser exporters and
 * instrumentation. Exporters resolve against location.href, while browser
 * instrumentation resolves relative requests against document.baseURI.
 */
export function createTelemetryUrlPatterns(endpoints: readonly TelemetryUrl[]): RegExp[] {
  const patterns = new Map<string, RegExp>()

  for (const endpoint of endpoints) {
    for (const url of resolveUrlForms(endpoint.url)) {
      const pattern = createEndpointPattern(endpoint.kind, url)
      patterns.set(`${pattern.source}/${pattern.flags}`, pattern)
    }
  }

  return [...patterns.values()]
}

export function assertBrowserReplayUrl(replayUrl: string): void {
  if (replayUrl.length === 0) {
    throw new Error('logfire-browser: sessionReplay.replayUrl must be a non-empty browser URL')
  }
  const bases = new Set([getLocationHref(), getDocumentBaseUri()].filter((base): base is string => base !== undefined))
  if (bases.size === 0) {
    bases.add('https://logfire.invalid/')
  }
  const resolvedUrls = [...bases].map((base) => resolveUrl(replayUrl, base))
  if (resolvedUrls.some((resolved) => resolved === undefined)) {
    throw new Error('logfire-browser: sessionReplay.replayUrl must be a valid browser URL')
  }
  if (resolvedUrls.some((resolved) => resolved?.pathname === '/')) {
    throw new Error('logfire-browser: sessionReplay.replayUrl must use a non-root path')
  }
  if (resolvedUrls.some((resolved) => resolved?.search !== '' || resolved.hash !== '')) {
    throw new Error('logfire-browser: sessionReplay.replayUrl must not contain a query or fragment')
  }
}

export function isBrowserReplayUrlValid(replayUrl: string): boolean {
  try {
    assertBrowserReplayUrl(replayUrl)
    return true
  } catch {
    return false
  }
}

function resolveUrlForms(url: string): string[] {
  const forms = new Set([url])
  const locationUrl = resolveUrl(url, getLocationHref())
  if (locationUrl !== undefined) {
    forms.add(locationUrl.href)
  }
  const documentUrl = resolveUrl(url, getDocumentBaseUri())
  if (documentUrl !== undefined) {
    forms.add(documentUrl.href)
  }
  return [...forms]
}

function getLocationHref(): string | undefined {
  const location = Reflect.get(globalThis, 'location') as unknown
  if (typeof location !== 'object' || location === null) {
    return undefined
  }
  const href = Reflect.get(location, 'href') as unknown
  return typeof href === 'string' ? href : undefined
}

function getDocumentBaseUri(): string | undefined {
  const document = Reflect.get(globalThis, 'document') as unknown
  if (typeof document !== 'object' || document === null) {
    return undefined
  }
  const baseUri = Reflect.get(document, 'baseURI') as unknown
  return typeof baseUri === 'string' ? baseUri : undefined
}

function resolveUrl(url: string, base: string | undefined): URL | undefined {
  try {
    return base === undefined ? new URL(url) : new URL(url, base)
  } catch {
    return undefined
  }
}

function createEndpointPattern(kind: TelemetryUrlKind, url: string): RegExp {
  return kind === 'exact' ? createExactPattern(url) : createReplayBasePattern(url)
}

function createExactPattern(url: string): RegExp {
  const hashIndex = url.indexOf('#')
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')

  if (hashIndex !== -1) {
    return new RegExp(`^${escapeRegExp(url)}$`, 'u')
  }
  if (queryIndex !== -1) {
    return new RegExp(`^${escapeRegExp(withoutHash)}(?:#.*)?$`, 'u')
  }
  return new RegExp(`^${escapeRegExp(withoutHash)}(?:[?#].*)?$`, 'u')
}

function createReplayBasePattern(url: string): RegExp {
  const normalizedUrl = url === '/' ? url : url.replace(/\/+$/u, '')
  return new RegExp(`^${escapeRegExp(normalizedUrl)}/[^/?#]+(?:\\?[^#]*)?(?:#.*)?$`, 'u')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
