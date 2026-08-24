import { describe, expect, it } from 'vitest'

import { isUserActivityEvent, resolveFlushInterval } from './activity'
import { EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

describe('isUserActivityEvent', () => {
  it.each([
    IncrementalSource.MouseMove,
    IncrementalSource.MouseInteraction,
    IncrementalSource.Scroll,
    IncrementalSource.ViewportResize,
    IncrementalSource.Input,
    IncrementalSource.TouchMove,
    IncrementalSource.MediaInteraction,
    IncrementalSource.Drag,
    IncrementalSource.Selection,
  ])('recognizes incremental source %s as user activity', (source) => {
    expect(isUserActivityEvent({ type: EventType.IncrementalSnapshot, data: { source }, timestamp: 1 })).toBe(true)
  })

  it.each([
    { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Mutation }, timestamp: 1 },
    { type: EventType.Custom, data: { source: IncrementalSource.MouseInteraction }, timestamp: 1 },
    { type: EventType.IncrementalSnapshot, data: null, timestamp: 1 },
  ] satisfies RrwebEvent[])('rejects non-activity event %#', (event) => {
    expect(isUserActivityEvent(event)).toBe(false)
  })
})

describe('resolveFlushInterval', () => {
  it.each([
    { inactivityMs: 29_999, expectedMs: 5_000 },
    { inactivityMs: 30_000, expectedMs: 60_000 },
    { inactivityMs: 5 * 60_000 - 1, expectedMs: 60_000 },
    { inactivityMs: 5 * 60_000, expectedMs: 5 * 60_000 },
  ])('returns $expectedMs ms after $inactivityMs ms without activity', ({ expectedMs, inactivityMs }) => {
    expect(resolveFlushInterval(5_000, inactivityMs)).toBe(expectedMs)
  })

  it('never shortens the configured interval', () => {
    expect(resolveFlushInterval(10 * 60_000, 0)).toBe(10 * 60_000)
    expect(resolveFlushInterval(10 * 60_000, 30_000)).toBe(10 * 60_000)
    expect(resolveFlushInterval(10 * 60_000, 5 * 60_000)).toBe(10 * 60_000)
  })
})
