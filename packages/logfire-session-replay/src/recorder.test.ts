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
import type { RrwebEvent } from './types'

function lastOptions(): Record<string, unknown> {
  return record.mock.calls.at(-1)![0] as Record<string, unknown>
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
    startRecording({ emit: () => {}, maskAllInputs: true })
    const options = lastOptions()
    expect(options['recordCanvas']).toBe(false)
    expect(options['collectFonts']).toBe(false)
    expect(options['maskAllInputs']).toBe(true)
    expect(options['sampling']).toMatchObject({
      mousemove: true,
      mouseInteraction: true,
      scroll: 150,
      media: 800,
      input: 'last',
    })
  })

  it('omits optional selectors and checkoutEveryNms when unset', () => {
    startRecording({ emit: () => {}, maskAllInputs: false, checkoutEveryNms: 0 })
    const options = lastOptions()
    expect('maskTextSelector' in options).toBe(false)
    expect('blockSelector' in options).toBe(false)
    expect('checkoutEveryNms' in options).toBe(false)
  })

  it('passes optional selectors and checkoutEveryNms when set', () => {
    startRecording({
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

  it('forwards rrweb emitted events to the caller', () => {
    const emitted: RrwebEvent[] = []
    startRecording({ emit: (event) => emitted.push(event), maskAllInputs: true })
    const rrwebEmit = lastOptions()['emit'] as (event: unknown) => void
    const event = { type: 2, data: { node: {} }, timestamp: 5 }
    rrwebEmit(event)
    expect(emitted).toEqual([event])
  })

  it('forwards custom events and full snapshots through rrweb statics', () => {
    const handle = startRecording({ emit: () => {}, maskAllInputs: true })
    handle.addCustomEvent('logfire.error', { message: 'x' })
    handle.takeFullSnapshot()
    expect(record.addCustomEvent).toHaveBeenCalledWith('logfire.error', { message: 'x' })
    expect(record.takeFullSnapshot).toHaveBeenCalledWith(true)
  })

  it('stops the rrweb recorder when a stop function is returned', () => {
    startRecording({ emit: () => {}, maskAllInputs: true }).stop()
    expect(stopFn).toHaveBeenCalledTimes(1)
  })

  it('treats a missing rrweb stop function as startup failure', () => {
    record.mockReturnValueOnce(undefined)
    expect(() => startRecording({ emit: () => {}, maskAllInputs: true })).toThrow('logfire session replay: rrweb failed to start recording')
  })
})
