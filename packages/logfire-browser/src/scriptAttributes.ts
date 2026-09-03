export const MAX_SCRIPT_ATTRIBUTE_CODE_POINTS = 200
export const MAX_SCRIPT_SOURCE_URL_CODE_POINTS = 2_048

export interface NormalizedScriptAttributes {
  duration: number
  functionName?: string
  invoker?: string
  invokerType?: ScriptInvokerType
  sourceUrl?: string
}

const SCRIPT_INVOKER_TYPES = new Set<ScriptInvokerType>([
  'classic-script',
  'module-script',
  'event-listener',
  'user-callback',
  'resolve-promise',
  'reject-promise',
])

export function capScriptAttribute(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  return capCodePoints(value, MAX_SCRIPT_ATTRIBUTE_CODE_POINTS)
}

export function normalizeScriptSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  try {
    const baseUrl = getCurrentPageUrl()
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl)
    url.search = ''
    url.hash = ''
    url.username = ''
    url.password = ''
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return capCodePoints(url.href, MAX_SCRIPT_SOURCE_URL_CODE_POINTS)
    }
    if (url.protocol === 'blob:') {
      return url.origin === 'null' ? 'blob:' : capCodePoints(`blob:${url.origin}`, MAX_SCRIPT_SOURCE_URL_CODE_POINTS)
    }
    return url.protocol
  } catch {
    return undefined
  }
}

export function normalizeScriptEntry(value: unknown): NormalizedScriptAttributes | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const entry = value as {
    duration?: unknown
    invoker?: unknown
    invokerType?: unknown
    sourceFunctionName?: unknown
    sourceURL?: unknown
  }
  if (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) || entry.duration < 0) {
    return undefined
  }

  const functionName = capScriptAttribute(entry.sourceFunctionName)
  const invoker = capScriptAttribute(entry.invoker)
  const sourceUrl = normalizeScriptSourceUrl(entry.sourceURL)
  return {
    duration: entry.duration,
    ...(functionName === undefined ? {} : { functionName }),
    ...(invoker === undefined ? {} : { invoker }),
    ...(isScriptInvokerType(entry.invokerType) ? { invokerType: entry.invokerType } : {}),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  }
}

function getCurrentPageUrl(): string | undefined {
  try {
    const href = (globalThis as { location?: { href?: string } }).location?.href
    return href === undefined || href === '' ? undefined : href
  } catch {
    return undefined
  }
}

function isScriptInvokerType(value: unknown): value is ScriptInvokerType {
  return typeof value === 'string' && SCRIPT_INVOKER_TYPES.has(value as ScriptInvokerType)
}

function capCodePoints(value: string, maximum: number): string {
  const codePoints = Array.from(value)
  return codePoints.length <= maximum ? value : codePoints.slice(0, maximum).join('')
}
