import { record } from 'rrweb'

import { redactUrl } from './privacy'
import { EventType } from './types'
import type { RrwebEvent } from './types'

type RrwebRecord = ((options: unknown) => (() => void) | undefined) & {
  addCustomEvent?: (tag: string, payload: unknown) => void
  takeFullSnapshot?: (isCheckout?: boolean) => void
}

const rrwebRecord = record as unknown as RrwebRecord

export interface RecorderHandle {
  stop(): void
  addCustomEvent(tag: string, payload: unknown): void
  takeFullSnapshot(): void
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
    takeFullSnapshot: () => {
      rrwebRecord.takeFullSnapshot?.(true)
    },
  }
}

function sanitizeRecorderEvent(event: RrwebEvent, patterns: RegExp[]): RrwebEvent {
  if (event.type !== EventType.Meta || typeof event.data !== 'object' || event.data === null) {
    return event
  }

  const data = event.data as Record<string, unknown>
  if (typeof data['href'] !== 'string') {
    return event
  }

  const href = redactUrl(data['href'], patterns, window.location.href)
  if (href === data['href']) {
    return event
  }

  return { ...event, data: { ...data, href } }
}
