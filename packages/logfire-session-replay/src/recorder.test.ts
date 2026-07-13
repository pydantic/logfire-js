/**
 * @vitest-environment jsdom
 */
/* eslint-disable import/first, @typescript-eslint/no-non-null-assertion, @typescript-eslint/strict-void-return, no-empty-function, vitest/require-mock-type-parameters */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

const { record, stopFn } = vi.hoisted(() => {
  const stopFn = vi.fn()
  const record = vi.fn(() => stopFn) as Mock & {
    addCustomEvent: Mock
    takeFullSnapshot: Mock
  }
  record.addCustomEvent = vi.fn()
  record.takeFullSnapshot = vi.fn()
  return { record, stopFn }
})

vi.mock('rrweb', () => ({ record }))

import { startRecording } from './recorder'
import type { RecorderOptions } from './recorder'
import { EventType } from './types'
import type { RrwebEvent } from './types'

function lastOptions(): Record<string, unknown> {
  return record.mock.calls.at(-1)![0] as Record<string, unknown>
}

function startRecordingForTest(
  options: Pick<RecorderOptions, 'emit'> & Partial<Omit<RecorderOptions, 'emit'>>
): ReturnType<typeof startRecording> {
  return startRecording({
    maskAllInputs: true,
    maskAllText: false,
    redactUrlPatterns: [],
    ...options,
  })
}

beforeEach(() => {
  record.mockClear()
  record.mockReturnValue(stopFn)
  stopFn.mockClear()
  record.addCustomEvent.mockClear()
  record.takeFullSnapshot.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('startRecording', () => {
  it('passes conservative privacy and performance options to rrweb', () => {
    startRecordingForTest({ emit: () => {}, maskAllInputs: true, maskAllText: true })
    const options = lastOptions()
    expect(options['recordCanvas']).toBe(false)
    expect(options['collectFonts']).toBe(false)
    expect(options['maskAllInputs']).toBe(true)
    expect(options['maskTextSelector']).toBe('*')
    expect(options['sampling']).toMatchObject({
      mousemove: true,
      mouseInteraction: true,
      scroll: 150,
      media: 800,
      input: 'last',
    })
  })

  it('omits optional selectors and checkoutEveryNms when unset', () => {
    startRecordingForTest({ emit: () => {}, maskAllInputs: false, checkoutEveryNms: 0 })
    const options = lastOptions()
    expect('maskTextSelector' in options).toBe(false)
    expect('blockSelector' in options).toBe(false)
    expect('checkoutEveryNms' in options).toBe(false)
  })

  it('passes optional selectors and checkoutEveryNms when set', () => {
    startRecordingForTest({
      emit: () => {},
      maskAllInputs: false,
      maskTextSelector: '.secret',
      blockSelector: '.blocked',
      checkoutEveryNms: 120_000,
    })
    expect(lastOptions()).toMatchObject({
      maskTextSelector: '.secret',
      blockSelector: '.blocked',
      checkoutEveryNms: 120_000,
    })
  })

  it('requires maskAllText false before applying a selective text selector', () => {
    startRecordingForTest({ emit: () => {}, maskAllText: true, maskTextSelector: '.secret' })
    expect(lastOptions()['maskTextSelector']).toBe('*')

    startRecordingForTest({ emit: () => {}, maskAllText: false, maskTextSelector: '.secret' })
    expect(lastOptions()['maskTextSelector']).toBe('.secret')
  })

  it('forwards rrweb emitted events to the caller', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), maskAllInputs: true })
    const rrwebEmit = lastOptions()['emit'] as (event: unknown) => void
    const event = { type: 2, data: { node: {} }, timestamp: 5 }
    rrwebEmit(event)
    expect(emitted).toEqual([event])
  })

  it('sanitizes matching rrweb Meta hrefs without changing other events', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [/.+/u] })
    const rrwebEmit = lastOptions()['emit'] as (event: unknown) => void
    const meta: RrwebEvent = {
      type: EventType.Meta,
      data: { href: 'https://app.example.test/orders?token=secret#details', width: 800 },
      timestamp: 5,
    }
    const snapshot: RrwebEvent = { type: EventType.FullSnapshot, data: { node: { href: '?token=attribute' } }, timestamp: 6 }

    rrwebEmit(meta)
    rrwebEmit(snapshot)

    expect(emitted[0]).toEqual({ ...meta, data: { href: 'https://app.example.test/orders', width: 800 } })
    expect(emitted[1]).toBe(snapshot)
    expect(meta.data).toEqual({ href: 'https://app.example.test/orders?token=secret#details', width: 800 })
  })

  it('forwards custom events and full snapshots through rrweb statics', () => {
    const handle = startRecordingForTest({ emit: () => {}, maskAllInputs: true })
    handle.addCustomEvent('logfire.error', { message: 'x' })
    handle.takeFullSnapshot()
    expect(record.addCustomEvent).toHaveBeenCalledWith('logfire.error', { message: 'x' })
    expect(record.takeFullSnapshot).toHaveBeenCalledWith(true)
  })

  it('stops the rrweb recorder when a stop function is returned', () => {
    startRecordingForTest({ emit: () => {}, maskAllInputs: true }).stop()
    expect(stopFn).toHaveBeenCalledTimes(1)
  })

  it('treats a missing rrweb stop function as startup failure', () => {
    record.mockReturnValueOnce(undefined)
    expect(() => startRecordingForTest({ emit: () => {}, maskAllInputs: true })).toThrow(
      'logfire session replay: rrweb failed to start recording'
    )
  })
})
