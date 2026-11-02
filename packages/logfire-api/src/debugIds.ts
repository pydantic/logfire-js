import type { Attributes } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { ATTRIBUTES_DEBUG_IDS_KEY } from './constants'

const ATTR_EXCEPTION_STACKTRACE = 'exception.stacktrace'

// Names written by build tools; a published SDK reads them forever, so they cannot change.
interface DebugIdGlobals {
  /** Written by `logfire sourcemap inject`, keyed by the `new Error().stack` captured at bundle load. */
  _logfireDebugIds?: unknown
  /** Vendor-neutral registry with the same shape, written by Turbopack and read by Sentry. */
  _debugIds?: unknown
  /** Release identifier written by `logfire sourcemap inject`. */
  _logfireRelease?: unknown
}

const V8_FRAME_START_PATTERN = /^\s*at\s/u
const URL_USERINFO_PATTERN = /^([a-z][\w+.-]*:\/\/)[^/@]*@/iu

/** Drops the query, fragment, and credentials, so a cache-busting query does not break the match. */
export function normalizeFrameUrl(url: string): string {
  const queryStart = url.search(/[?#]/u)
  const withoutQuery = queryStart === -1 ? url : url.slice(0, queryStart)
  return withoutQuery.replace(URL_USERINFO_PATTERN, '$1')
}

function isDigits(value: string): boolean {
  if (value === '') {
    return false
  }
  for (const char of value) {
    if (char < '0' || char > '9') {
      return false
    }
  }
  return true
}

function withoutLineColumn(location: string): string | undefined {
  const columnStart = location.lastIndexOf(':')
  const lineStart = location.lastIndexOf(':', columnStart - 1)
  if (lineStart === -1 || !isDigits(location.slice(columnStart + 1)) || !isDigits(location.slice(lineStart + 1, columnStart))) {
    return undefined
  }
  return location.slice(0, lineStart)
}

// Parsed with string scans rather than regular expressions: a frame line can carry error message
// text, and patterns with nested quantifiers backtrack polynomially on crafted input.
function frameLocationWithPosition(line: string, v8: boolean): string | undefined {
  const trimmed = line.trim()
  if (v8) {
    // V8 frames: `at fn (location)` or `at location`, where location ends with `:line:column`.
    if (!V8_FRAME_START_PATTERN.test(trimmed)) {
      return undefined
    }
    const frame = trimmed.slice(2).trimStart()
    const nameEnd = frame.indexOf(' (')
    return frame.endsWith(')') && nameEnd !== -1 ? frame.slice(nameEnd + 2, -1) : frame
  }
  // SpiderMonkey and JavaScriptCore frames: `fn@location:line:column`; the function name holds no `@`.
  const nameEnd = trimmed.indexOf('@')
  return nameEnd === -1 ? undefined : trimmed.slice(nameEnd + 1)
}

function frameLocation(line: string, v8: boolean): string | undefined {
  const withPosition = frameLocationWithPosition(line, v8)
  let location = withPosition === undefined ? undefined : withoutLineColumn(withPosition)
  if (location === undefined) {
    return undefined
  }
  // Code run through eval or new Function was not part of any bundle the inject step processed.
  if (location.startsWith('eval at ') || location.includes(' > eval') || location.includes(' > Function')) {
    return undefined
  }
  location = location.trim()
  return location === '' || location === '<anonymous>' ? undefined : normalizeFrameUrl(location)
}

/**
 * Returns the normalized location of every frame in a stack string, in stack order. Understands V8
 * (Chrome, Node, Workers), SpiderMonkey (Firefox) and JavaScriptCore (Safari) formats.
 */
export function parseStackFrameUrls(stack: string): string[] {
  const lines = stack.split('\n')
  // V8 puts the message in the stack, and a message can look like a Firefox frame.
  const v8 = lines.some((line) => V8_FRAME_START_PATTERN.test(line))
  const urls: string[] = []
  for (const line of lines) {
    const url = frameLocation(line, v8)
    if (url !== undefined) {
      urls.push(url)
    }
  }
  return urls
}

// A registry key never changes the URL it names, so each key is parsed once.
const registryKeyUrls = new Map<string, string | undefined>()

function registryKeyUrl(key: string): string | undefined {
  if (registryKeyUrls.has(key)) {
    return registryKeyUrls.get(key)
  }
  // The first frame of the captured stack is the inject snippet itself, inside its bundle.
  const url = parseStackFrameUrls(key)[0]
  registryKeyUrls.set(key, url)
  return url
}

function readRegistry(globals: DebugIdGlobals, name: '_debugIds' | '_logfireDebugIds'): Record<string, unknown> | undefined {
  const registry = globals[name]
  return typeof registry === 'object' && registry !== null ? (registry as Record<string, unknown>) : undefined
}

function addRegistryEntries(target: Map<string, string>, registry: Record<string, unknown> | undefined): void {
  if (registry === undefined) {
    return
  }
  for (const key of Object.keys(registry)) {
    const debugId = registry[key]
    if (typeof debugId !== 'string' || debugId === '') {
      continue
    }
    const url = registryKeyUrl(key)
    if (url !== undefined) {
      target.set(url, debugId)
    }
  }
}

// Read for every exception rather than once, because lazily loaded chunks register later.
function loadedBundleDebugIds(): Map<string, string> | undefined {
  const globals = globalThis as DebugIdGlobals
  const primary = readRegistry(globals, '_logfireDebugIds')
  const fallback = readRegistry(globals, '_debugIds')
  if (primary === undefined && fallback === undefined) {
    return undefined
  }
  const debugIds = new Map<string, string>()
  addRegistryEntries(debugIds, fallback)
  addRegistryEntries(debugIds, primary)
  return debugIds
}

/** Returns `{url: debugId}` for the injected bundles in a stack, or undefined when none match. */
export function debugIdsForStack(stack: string): Record<string, string> | undefined {
  try {
    const loaded = loadedBundleDebugIds()
    if (loaded === undefined || loaded.size === 0) {
      return undefined
    }
    const matched = new Map<string, string>()
    for (const url of parseStackFrameUrls(stack)) {
      const debugId = loaded.get(url)
      if (debugId !== undefined) {
        matched.set(url, debugId)
      }
    }
    return matched.size === 0 ? undefined : sortedRecord(matched)
  } catch {
    // A hostile registry or getter must never break error reporting.
    return undefined
  }
}

function sortedRecord(entries: Map<string, string>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const url of [...entries.keys()].sort()) {
    record[url] = entries.get(url) as string
  }
  return record
}

/** Returns the `logfire.debug_ids` attribute value for a stack, or undefined when no bundle matches. */
export function debugIdsAttributeForStack(stack: string): string | undefined {
  const debugIds = debugIdsForStack(stack)
  return debugIds === undefined ? undefined : JSON.stringify(debugIds)
}

function stackOf(attributes: Attributes | undefined): string | undefined {
  const stack = attributes?.[ATTR_EXCEPTION_STACKTRACE]
  return typeof stack === 'string' ? stack : undefined
}

/**
 * Stamps `logfire.debug_ids` on each `exception` event and on the span itself, from the stack traces
 * the span already holds. Existing values are kept. Mutates in place, so it also works on ended spans.
 */
export function stampSpanDebugIds(span: Pick<ReadableSpan, 'attributes' | 'events'>): void {
  try {
    const globals = globalThis as DebugIdGlobals
    if (readRegistry(globals, '_logfireDebugIds') === undefined && readRegistry(globals, '_debugIds') === undefined) {
      return
    }
    const spanDebugIds = new Map<string, string>()
    const collect = (debugIds: Record<string, string>) => {
      for (const [url, debugId] of Object.entries(debugIds)) {
        spanDebugIds.set(url, debugId)
      }
    }
    for (const event of span.events) {
      const stack = event.name === 'exception' ? stackOf(event.attributes) : undefined
      const debugIds = stack === undefined ? undefined : debugIdsForStack(stack)
      if (debugIds === undefined || event.attributes === undefined) {
        continue
      }
      collect(debugIds)
      event.attributes[ATTRIBUTES_DEBUG_IDS_KEY] ??= JSON.stringify(debugIds)
    }
    if (span.attributes[ATTRIBUTES_DEBUG_IDS_KEY] !== undefined) {
      return
    }
    const spanStack = stackOf(span.attributes)
    const debugIds = spanStack === undefined ? undefined : debugIdsForStack(spanStack)
    if (debugIds !== undefined) {
      collect(debugIds)
    }
    if (spanDebugIds.size > 0) {
      span.attributes[ATTRIBUTES_DEBUG_IDS_KEY] = JSON.stringify(sortedRecord(spanDebugIds))
    }
  } catch {
    // Build identity is best-effort and must never affect export.
  }
}

/**
 * Adds `logfire.debug_ids` to spans that record exceptions, including those recorded by
 * instrumentations through `span.recordException()`. Add it before the exporting processor.
 */
export class DebugIdSpanProcessor implements SpanProcessor {
  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  onEnd(span: ReadableSpan): void {
    stampSpanDebugIds(span)
  }

  onStart(): void {
    return undefined
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

/** Returns the release identifier the inject step stamped into the loaded bundle, if any. */
export function readInjectedRelease(): string | undefined {
  try {
    const release: unknown = Reflect.get(globalThis, '_logfireRelease')
    return typeof release === 'string' && release.trim() !== '' ? release : undefined
  } catch {
    return undefined
  }
}
