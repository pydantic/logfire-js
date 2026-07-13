import { record } from 'rrweb'

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
  maskAllInputs: boolean
  maskTextSelector?: string
  blockSelector?: string
  checkoutEveryNms?: number
}

export function startRecording(options: RecorderOptions): RecorderHandle {
  const recordOptions: Record<string, unknown> = {
    emit: (event: unknown) => {
      options.emit(event as RrwebEvent)
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

  if (options.maskTextSelector !== undefined && options.maskTextSelector.length > 0) {
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
