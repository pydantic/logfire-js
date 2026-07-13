import { record } from 'rrweb'

import { redactUrl } from './privacy'
import { EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

type RrwebRecord = ((options: unknown) => (() => void) | undefined) & {
  addCustomEvent?: (tag: string, payload: unknown) => void
}

const rrwebRecord = record as unknown as RrwebRecord
const URL_ATTRIBUTE_NAMES = new Set(['action', 'formaction', 'href', 'src'])

export interface RecorderHandle {
  stop(): void
  addCustomEvent(tag: string, payload: unknown): void
}

export interface RecorderOptions {
  emit: (event: RrwebEvent) => void
  maskAllText: boolean
  maskAllInputs: boolean
  maskTextSelector?: string
  blockSelector?: string
  checkoutEveryNms?: number
  redactUrlPatterns: RegExp[]
}

export function startRecording(options: RecorderOptions): RecorderHandle {
  const recordOptions: Record<string, unknown> = {
    emit: (event: unknown) => {
      options.emit(sanitizeRecorderEvent(event as RrwebEvent, options.redactUrlPatterns))
    },
    maskAllInputs: options.maskAllInputs,
    recordCanvas: false,
    collectFonts: false,
    sampling: {
      mousemove: true,
      mouseInteraction: true,
      scroll: 150,
      media: 800,
      input: 'last',
    },
  }

  if (options.maskAllText) {
    recordOptions['maskTextSelector'] = '*'
  } else if (options.maskTextSelector !== undefined && options.maskTextSelector.length > 0) {
    recordOptions['maskTextSelector'] = options.maskTextSelector
  }
  if (options.blockSelector !== undefined && options.blockSelector.length > 0) {
    recordOptions['blockSelector'] = options.blockSelector
  }
  if (options.checkoutEveryNms !== undefined && options.checkoutEveryNms > 0) {
    recordOptions['checkoutEveryNms'] = options.checkoutEveryNms
  }

  const stop = rrwebRecord(recordOptions)
  if (stop === undefined) {
    throw new Error('logfire session replay: rrweb failed to start recording')
  }

  return {
    stop: () => {
      stop()
    },
    addCustomEvent: (tag, payload) => {
      rrwebRecord.addCustomEvent?.(tag, payload)
    },
  }
}

function sanitizeRecorderEvent(event: RrwebEvent, patterns: RegExp[]): RrwebEvent {
  if (typeof event.data !== 'object' || event.data === null) {
    return event
  }

  const data = event.data as Record<string, unknown>
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
