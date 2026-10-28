import { record } from '@rrweb/record'

import { redactUrl, redactUrlsInText } from './privacy'
import { CustomTag, EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

const URL_ATTRIBUTE_NAMES = new Set(['action', 'formaction', 'href', 'src'])
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
}

export function startRecording(options: RecorderOptions): RecorderHandle {
  const beforeUserActivity = () => {
    options.beforeUserActivity?.()
  }
  const recordOptions: RrwebRecordOptions = {
    emit: (event) => {
      options.emit(sanitizeRecorderEvent(event, options.redactUrlPatterns))
    },
    maskAllInputs: options.maskAllInputs,
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

function sanitizeRecorderEvent(event: RrwebEvent, patterns: RegExp[]): RrwebEvent {
  if (typeof event.data !== 'object' || event.data === null) {
    return event
  }

  const data = event.data as Record<string, unknown>
  if (event.type === EventType.Custom) {
    return sanitizeCustomEvent(event, data, patterns)
  }
  if (event.type === EventType.Meta) {
    if (typeof data['href'] !== 'string') {
      return event
    }

    const href = redactUrl(data['href'], patterns, window.location.href)
    return href === data['href'] ? event : { ...event, data: { ...data, href } }
  }

  if (
    event.type !== EventType.FullSnapshot &&
    (event.type !== EventType.IncrementalSnapshot || data['source'] !== IncrementalSource.Mutation)
  ) {
    return event
  }

  const sanitizedData = sanitizeSnapshotValue(data, patterns)
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
      sanitized['message'] = redactUrlsInText(fields['message'], patterns, baseUrl)
    }
    if (typeof fields['source'] === 'string') {
      sanitized['source'] = redactUrl(fields['source'], patterns, baseUrl)
    }
    if (typeof fields['stack'] === 'string') {
      sanitized['stack'] = redactUrlsInText(fields['stack'], patterns, baseUrl, { stackTrace: true })
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

function sanitizeSnapshotValue(value: unknown, patterns: RegExp[]): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const sanitized: unknown[] = []
    for (const item of value) {
      const next = sanitizeSnapshotValue(item, patterns)
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
    const next =
      key === 'attributes' && !Array.isArray(item) ? sanitizeUrlAttributes(item, patterns) : sanitizeSnapshotValue(item, patterns)
    if (next !== item) {
      changed = true
    }
    sanitized[key] = next
  }
  return changed ? sanitized : value
}

function sanitizeUrlAttributes(value: unknown, patterns: RegExp[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const attributes = value as Record<string, unknown>
  let changed = false
  const sanitized: Record<string, unknown> = {}
  for (const [name, attributeValue] of Object.entries(attributes)) {
    if (!URL_ATTRIBUTE_NAMES.has(name.toLowerCase()) || typeof attributeValue !== 'string') {
      sanitized[name] = attributeValue
      continue
    }
    const next = redactUrl(attributeValue, patterns, window.location.href)
    if (next !== attributeValue) {
      changed = true
    }
    sanitized[name] = next
  }
  return changed ? sanitized : value
}
