import { record } from '@rrweb/record'

import { cutText, redactCssUrls, redactSrcset, redactUrl, redactUrlsInText, truncationSuffix } from './privacy'
import type { UrlTransform } from './privacy'
import { CustomTag, EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

// rrweb stores an iframe `src` as `rr_src` when it does not record the frame's document.
const URL_ATTRIBUTE_NAMES = new Set(['action', 'background', 'cite', 'data', 'formaction', 'href', 'poster', 'rr_src', 'src', 'xlink:href'])
const SRCSET_ATTRIBUTE_NAMES = new Set(['imagesrcset', 'srcset'])
const TEXT_ATTRIBUTE_NAMES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
])
// UI libraries and themes select styles through these attributes, so masking them would make
// playback show a different state or theme than the user saw.
const UI_STATE_DATA_ATTRIBUTE_NAMES = new Set([
  'data-active',
  'data-align',
  'data-bs-theme',
  'data-checked',
  'data-disabled',
  'data-headlessui-state',
  'data-highlighted',
  'data-orientation',
  'data-placement',
  'data-popper-placement',
  'data-selected',
  'data-side',
  'data-size',
  'data-slot',
  'data-state',
  'data-theme',
  'data-variant',
])
// Flag values such as `data-expanded="true"` carry no personal data and are matched by selectors.
const FLAG_DATA_ATTRIBUTE_VALUES = new Set(['', 'false', 'true'])
const TEXT_VALUE_INPUT_TYPES = new Set(['button', 'reset', 'submit'])
const MAX_ERROR_MESSAGE_LENGTH = 1024
const MAX_ERROR_STACK_LENGTH = 8192
// rrweb's `maskAllInputs` map, plus hidden inputs, whose values often carry tokens and ids.
const MASK_ALL_INPUT_OPTIONS = {
  color: true,
  date: true,
  'datetime-local': true,
  email: true,
  hidden: true,
  month: true,
  number: true,
  password: true,
  range: true,
  search: true,
  select: true,
  tel: true,
  text: true,
  textarea: true,
  time: true,
  url: true,
  week: true,
}
type RrwebRecordOptions = NonNullable<Parameters<typeof record<RrwebEvent>>[0]>

export interface RecorderHandle {
  stop(): void
  addCustomEvent(tag: string, payload: unknown): void
  takeFullSnapshot(): void
}

export interface RecorderOptions {
  emit: (event: RrwebEvent) => void
  beforeUserActivity?: () => void
  maskAllText: boolean
  maskAllInputs: boolean
  maskTextSelector?: string
  blockSelector?: string
  checkoutEveryNms?: number
  redactUrlPatterns: RegExp[]
  transformUrl?: UrlTransform | undefined
}

interface SanitizeOptions {
  maskTextAttributes: boolean
  patterns: RegExp[]
  transformUrl: UrlTransform | undefined
}

export function startRecording(options: RecorderOptions): RecorderHandle {
  const beforeUserActivity = () => {
    options.beforeUserActivity?.()
  }
  const sanitizeOptions: SanitizeOptions = {
    maskTextAttributes: options.maskAllText,
    patterns: options.redactUrlPatterns,
    transformUrl: options.transformUrl,
  }
  const recordOptions: RrwebRecordOptions = {
    emit: (event) => {
      options.emit(sanitizeRecorderEvent(event, sanitizeOptions))
    },
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    recordCrossOriginIframes: false,
    slimDOMOptions: 'all',
    hooks: {
      input: beforeUserActivity,
      mediaInteaction: beforeUserActivity,
      mouseInteraction: beforeUserActivity,
      mousemove: beforeUserActivity,
      scroll: beforeUserActivity,
      selection: beforeUserActivity,
      viewportResize: beforeUserActivity,
    },
    sampling: {
      mousemove: 100,
      mouseInteraction: true,
      scroll: 250,
      media: 800,
      input: 'last',
    },
  }

  if (options.maskAllInputs) {
    recordOptions.maskInputOptions = MASK_ALL_INPUT_OPTIONS
  } else {
    recordOptions.maskAllInputs = false
  }
  if (options.maskAllText) {
    recordOptions.maskTextSelector = '*'
  } else if (options.maskTextSelector !== undefined && options.maskTextSelector.length > 0) {
    recordOptions.maskTextSelector = options.maskTextSelector
  }
  if (options.blockSelector !== undefined && options.blockSelector.length > 0) {
    recordOptions.blockSelector = options.blockSelector
  }
  if (options.checkoutEveryNms !== undefined && options.checkoutEveryNms > 0) {
    recordOptions.checkoutEveryNms = options.checkoutEveryNms
  }

  const stop = record(recordOptions)
  if (stop === undefined) {
    throw new Error('logfire session replay: rrweb failed to start recording')
  }

  return {
    stop: () => {
      stop()
    },
    addCustomEvent: (tag, payload) => {
      record.addCustomEvent(tag, payload)
    },
    takeFullSnapshot: () => {
      record.takeFullSnapshot(true)
    },
  }
}

function sanitizeRecorderEvent(event: RrwebEvent, options: SanitizeOptions): RrwebEvent {
  if (typeof event.data !== 'object' || event.data === null) {
    return event
  }

  const data = event.data as Record<string, unknown>
  if (event.type === EventType.Custom) {
    return sanitizeCustomEvent(event, data, options.patterns)
  }
  if (event.type === EventType.Meta) {
    if (typeof data['href'] !== 'string') {
      return event
    }

    const href = redactUrl(data['href'], options.patterns, window.location.href, options.transformUrl)
    return href === data['href'] ? event : { ...event, data: { ...data, href } }
  }

  if (
    event.type !== EventType.FullSnapshot &&
    (event.type !== EventType.IncrementalSnapshot || data['source'] !== IncrementalSource.Mutation)
  ) {
    return event
  }

  const sanitizedData = sanitizeSnapshotValue(data, options)
  return sanitizedData === data ? event : { ...event, data: sanitizedData }
}

// Network and navigation payloads are redacted where they are captured. Error and console payloads
// carry URLs inside free text (messages, stacks, arguments), so they are redacted here, where every
// custom event passes.
function sanitizeCustomEvent(event: RrwebEvent, data: Record<string, unknown>, patterns: RegExp[]): RrwebEvent {
  const payload = data['payload']
  if (typeof payload !== 'object' || payload === null) {
    return event
  }
  const fields = payload as Record<string, unknown>
  const baseUrl = window.location.href
  let sanitized: Record<string, unknown>
  if (data['tag'] === CustomTag.Error) {
    sanitized = { ...fields }
    if (typeof fields['message'] === 'string') {
      sanitized['message'] = boundText(fields['message'], MAX_ERROR_MESSAGE_LENGTH, (text) => redactUrlsInText(text, patterns, baseUrl))
    }
    if (typeof fields['source'] === 'string') {
      sanitized['source'] = redactUrl(fields['source'], patterns, baseUrl)
    }
    if (typeof fields['stack'] === 'string') {
      sanitized['stack'] = boundText(fields['stack'], MAX_ERROR_STACK_LENGTH, (text) =>
        redactUrlsInText(text, patterns, baseUrl, { stackTrace: true })
      )
    }
  } else if (data['tag'] === CustomTag.Console && Array.isArray(fields['args'])) {
    sanitized = {
      ...fields,
      args: fields['args'].map((arg: unknown) => (typeof arg === 'string' ? redactUrlsInText(arg, patterns, baseUrl) : arg)),
    }
  } else {
    return event
  }
  return { ...event, data: { ...data, payload: sanitized } }
}

// The text is cut before redaction, which bounds the work on an oversized message, and the marker is
// added after it, so redaction never reads the marker as part of a URL that the cut ended.
function boundText(text: string, maxLength: number, redact: (text: string) => string): string {
  const [kept, dropped] = cutText(text, maxLength)
  return `${redact(kept)}${truncationSuffix(dropped)}`
}

function sanitizeSnapshotValue(value: unknown, options: SanitizeOptions): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const sanitized: unknown[] = []
    for (const item of value) {
      const next = sanitizeSnapshotValue(item, options)
      if (next !== item) {
        changed = true
      }
      sanitized.push(next)
    }
    return changed ? sanitized : value
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  const record = value as Record<string, unknown>
  let changed = false
  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    const next = key === 'attributes' && !Array.isArray(item) ? sanitizeAttributes(item, options) : sanitizeSnapshotValue(item, options)
    if (next !== item) {
      changed = true
    }
    sanitized[key] = next
  }
  return changed ? sanitized : value
}

function sanitizeAttributes(value: unknown, options: SanitizeOptions): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const attributes = value as Record<string, unknown>
  const masksValue =
    options.maskTextAttributes && typeof attributes['type'] === 'string' && TEXT_VALUE_INPUT_TYPES.has(attributes['type'].toLowerCase())
  let changed = false
  const sanitized: Record<string, unknown> = {}
  for (const [name, attributeValue] of Object.entries(attributes)) {
    const lowerName = name.toLowerCase()
    const next = masksValue && lowerName === 'value' ? maskText(attributeValue) : sanitizeAttribute(lowerName, attributeValue, options)
    if (next !== attributeValue) {
      changed = true
    }
    sanitized[name] = next
  }
  return changed ? sanitized : value
}

function sanitizeAttribute(name: string, value: unknown, options: SanitizeOptions): unknown {
  const redact = (url: string) => redactUrl(url, options.patterns, window.location.href, options.transformUrl)
  if (name === 'style') {
    return sanitizeStyle(value, redact)
  }
  if (typeof value !== 'string') {
    return value
  }
  if (URL_ATTRIBUTE_NAMES.has(name)) {
    return redact(value)
  }
  if (SRCSET_ATTRIBUTE_NAMES.has(name)) {
    return redactSrcset(value, redact)
  }
  if (options.maskTextAttributes && isTextAttribute(name, value)) {
    return maskText(value)
  }
  return value
}

function isTextAttribute(name: string, value: string): boolean {
  if (TEXT_ATTRIBUTE_NAMES.has(name)) {
    return true
  }
  // `data-rr-*` attributes are rrweb's own markers, which playback reads.
  return (
    name.startsWith('data-') &&
    !name.startsWith('data-rr-') &&
    !UI_STATE_DATA_ATTRIBUTE_NAMES.has(name) &&
    !FLAG_DATA_ATTRIBUTE_VALUES.has(value)
  )
}

// rrweb records a full snapshot's style as text and a mutation's style as a map of changed properties,
// where a value with a priority is a `[value, priority]` pair.
function sanitizeStyle(value: unknown, redact: (url: string) => string): unknown {
  if (typeof value === 'string') {
    return redactCssUrls(value, redact)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  let changed = false
  const sanitized: Record<string, unknown> = {}
  for (const [property, propertyValue] of Object.entries(value as Record<string, unknown>)) {
    let next = propertyValue
    if (typeof propertyValue === 'string') {
      next = redactCssUrls(propertyValue, redact)
    } else if (Array.isArray(propertyValue)) {
      const [propertyText, ...rest] = propertyValue as unknown[]
      if (typeof propertyText === 'string') {
        const redacted = redactCssUrls(propertyText, redact)
        next = redacted === propertyText ? propertyValue : [redacted, ...rest]
      }
    }
    if (next !== propertyValue) {
      changed = true
    }
    sanitized[property] = next
  }
  return changed ? sanitized : value
}

// Matches rrweb's text masking, which keeps whitespace so masked layout stays close to the original.
function maskText(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\S/gu, '*') : value
}
