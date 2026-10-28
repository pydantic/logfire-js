import { diag } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import type { JsonPath, ScrubbedNote } from './AttributeScrubber'
import { ATTRIBUTES_SCRUBBED_KEY } from './constants'
import { logfireApiConfig } from './logfireApiConfig'
import { setOwn } from './ownRecord'

const SCRUBBING_FAILED_VALUE = '[Scrubbing failed]'

// Values the logfire API already scrubbed, keyed by the span's own attribute record. Tracking them
// here, rather than recognizing replacement text, keeps a scrubbing callback to one run per value
// and stops a value from claiming to be scrubbed already.
const scrubbedAtCreation = new WeakMap<object, Map<string, unknown>>()
// Span processors see a span in `onStart` before `tracer.startSpan` returns, so the attributes being
// started with are exposed here from `beginScrubbedSpan` until the API records them on the span.
let attributesInCreation: Readonly<Record<string, unknown>> | undefined

export interface ExportScrubbingOptions {
  /** Attribute values the caller already passed through the scrubber. Keys whose value is unchanged are skipped. */
  alreadyScrubbed?: Readonly<Record<string, unknown>>
  /** Attribute keys that a runtime package sets from SDK-owned values, such as browser session ids. */
  isSafeKey?: (key: string) => boolean
  /**
   * Key prefixes, ending in a separator, whose remainder is an application-chosen name, such as
   * `logfire.session.`. Only the remainder is matched against the scrubbing patterns.
   */
  namespacePrefixes?: readonly string[]
}

/**
 * The structural subset of the OpenTelemetry SDK log record that scrubbing needs. Typed locally so
 * this package does not depend on `@opentelemetry/sdk-logs`.
 */
export interface ScrubbableLogRecord {
  readonly attributes: Record<string, unknown>
  readonly body?: unknown
  setAttribute(key: string, value?: unknown): unknown
  setBody(body: never): unknown
}

/** Remember attribute values that the logfire API scrubbed before handing them to `span`. */
export function recordScrubbedAttributes(span: unknown, attributes: Readonly<Record<string, unknown>>): void {
  if (attributesInCreation === attributes) {
    attributesInCreation = undefined
  }
  const target = (span as Partial<ReadableSpan> | undefined)?.attributes
  if (target === undefined) {
    return
  }
  let known = scrubbedAtCreation.get(target)
  if (known === undefined) {
    known = new Map()
    scrubbedAtCreation.set(target, known)
  }
  for (const [key, value] of Object.entries(attributes)) {
    known.set(key, value)
  }
}

/** Call before starting a span with `attributes` the logfire API already scrubbed, then record them on the span. */
export function beginScrubbedSpan(attributes: Readonly<Record<string, unknown>>): void {
  attributesInCreation = attributes
}

/** For processors that copy a span in `onStart`: record the attributes the API scrubbed for it. */
export function recordScrubbedAttributesOnStart(span: Pick<ReadableSpan, 'attributes'>): void {
  const created = attributesInCreation
  // A start that threw never recorded its attributes, so a later span only inherits them when they
  // are its own.
  if (created === undefined || !Object.entries(created).every(([key, value]) => sameAttributeValue(span.attributes[key], value))) {
    return
  }
  recordScrubbedAttributes(span, created)
}

/** Carry the scrubbed-value record over to a copy of a span's attribute record. */
export function copyScrubbedAttributes(from: object, to: object): void {
  const known = scrubbedAtCreation.get(from)
  if (known !== undefined) {
    scrubbedAtCreation.set(to, new Map(known))
  }
}

/**
 * Scrub a finished span in place before it reaches an exporter.
 *
 * The logfire API scrubs the attributes it is given when it creates a span, but instrumentation
 * spans, attributes set after creation, events, and links never pass through that path. Like the
 * Python SDK's span processor, this pass covers all of them.
 */
export function scrubSpanForExport(span: ReadableSpan, options: ExportScrubbingOptions = {}): void {
  const notes: ScrubbedNote[] = []
  const known = new Map(scrubbedAtCreation.get(span.attributes))
  for (const [key, value] of Object.entries(options.alreadyScrubbed ?? {})) {
    known.set(key, value)
  }
  scrubAttributes(span.attributes, ['attributes'], notes, options, known)
  span.events.forEach((event, index) => {
    if (event.attributes !== undefined) {
      scrubAttributes(event.attributes, ['otel_events', index, 'attributes'], notes, options)
    }
  })
  span.links.forEach((link, index) => {
    if (link.attributes !== undefined) {
      scrubAttributes(link.attributes, ['links', index, 'attributes'], notes, options)
    }
  })
  if (notes.length > 0) {
    setOwn(span.attributes, ATTRIBUTES_SCRUBBED_KEY, mergeScrubbedNotes(span.attributes[ATTRIBUTES_SCRUBBED_KEY], notes))
  }
}

/**
 * Return a scrubbed copy of `span` for output that runs before the export pass, such as a console
 * exporter. `span` itself is left for the export pass to scrub.
 */
export function scrubbedSpanCopy(span: ReadableSpan, options: ExportScrubbingOptions = {}): ReadableSpan {
  const attributes = { ...span.attributes }
  copyScrubbedAttributes(span.attributes, attributes)
  // Inheriting from the span keeps its methods and getters, such as `spanContext()` and `duration`.
  const copy = Object.create(span, {
    attributes: { enumerable: true, value: attributes },
    events: {
      enumerable: true,
      value: span.events.map((event) => ({ ...event, ...(event.attributes ? { attributes: { ...event.attributes } } : {}) })),
    },
    links: {
      enumerable: true,
      value: span.links.map((link) => ({ ...link, ...(link.attributes ? { attributes: { ...link.attributes } } : {}) })),
    },
  }) as ReadableSpan
  scrubSpanForExport(copy, options)
  return copy
}

/** Scrub an OpenTelemetry log record's attributes and body before the batch processor queues it. */
export function scrubLogRecordForExport(logRecord: ScrubbableLogRecord): void {
  const notes: ScrubbedNote[] = []
  const attributes = { ...logRecord.attributes }
  scrubAttributes(attributes, ['attributes'], notes, {})
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== logRecord.attributes[key]) {
      logRecord.setAttribute(key, value)
    }
  }
  if (logRecord.body !== undefined) {
    const body = scrubOrFail(['log_body'], logRecord.body, notes)
    if (body !== logRecord.body) {
      logRecord.setBody(body as never)
    }
  }
  if (notes.length > 0) {
    logRecord.setAttribute(ATTRIBUTES_SCRUBBED_KEY, mergeScrubbedNotes(logRecord.attributes[ATTRIBUTES_SCRUBBED_KEY], notes))
  }
}

// Typed as a plain record because log attributes can hold nested maps that span `Attributes` cannot.
function scrubAttributes(
  attributes: Record<string, unknown>,
  path: JsonPath,
  notes: ScrubbedNote[],
  options: ExportScrubbingOptions,
  alreadyScrubbed?: ReadonlyMap<string, unknown>
): void {
  for (const [key, value] of Object.entries(attributes)) {
    // The scrubber leaves numbers and booleans alone.
    if (
      value === null ||
      value === undefined ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      key === ATTRIBUTES_SCRUBBED_KEY ||
      options.isSafeKey?.(key) === true ||
      (alreadyScrubbed?.has(key) === true && sameAttributeValue(value, alreadyScrubbed.get(key)))
    ) {
      continue
    }
    const prefix = options.namespacePrefixes?.find((candidate) => key.length > candidate.length && key.startsWith(candidate))
    const [scrubPath, scrubKey] = prefix === undefined ? [path, key] : [[...path, prefix.slice(0, -1)], key.slice(prefix.length)]
    const scrubbed = scrubOrFail(scrubPath, Object.fromEntries([[scrubKey, value]]), notes) as Record<string, unknown> | string
    const next = typeof scrubbed === 'string' ? scrubbed : scrubbed[scrubKey]
    if (!sameAttributeValue(value, next)) {
      setOwn(attributes, key, next)
    }
  }
}

function scrubOrFail(path: JsonPath, value: unknown, notes: ScrubbedNote[]): unknown {
  try {
    const [scrubbed, valueNotes] = logfireApiConfig.scrubber.scrubValue(path, value)
    notes.push(...valueNotes)
    return scrubbed
  } catch (error) {
    // A throwing scrubbing callback must not end the span or export the value it was asked about.
    diag.error('logfire: scrubbing failed before export', error)
    return SCRUBBING_FAILED_VALUE
  }
}

function sameAttributeValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index])
  }
  return a === b
}

function mergeScrubbedNotes(existing: unknown, notes: ScrubbedNote[]): string {
  let previous: unknown[] = []
  if (typeof existing === 'string') {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (Array.isArray(parsed)) {
        previous = parsed
      }
    } catch {
      // An unparseable note list is replaced rather than exported alongside the new notes.
    }
  }
  return JSON.stringify([...previous, ...notes])
}
