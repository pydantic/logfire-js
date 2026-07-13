import { describe, expect, it } from 'vitest'

import { computeChunkMeta } from './extract'
import { CustomTag, EventType, IncrementalSource, MouseInteractions } from './types'
import type { RrwebEvent } from './types'

const events: RrwebEvent[] = [
  { type: EventType.Meta, data: { href: 'https://app.example.com/a' }, timestamp: 100 },
  { type: EventType.FullSnapshot, data: { node: {} }, timestamp: 110 },
  { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseMove, positions: [] }, timestamp: 120 },
  {
    type: EventType.IncrementalSnapshot,
    data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click },
    timestamp: 130,
  },
  {
    type: EventType.IncrementalSnapshot,
    data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.DblClick },
    timestamp: 140,
  },
  { type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Input, text: 'x' }, timestamp: 150 },
  { type: EventType.Custom, data: { tag: CustomTag.Error, payload: { message: 'boom' } }, timestamp: 160 },
  { type: EventType.Custom, data: { tag: CustomTag.Trace, payload: { traceId: 'abc', spanId: 'def' } }, timestamp: 170 },
  { type: EventType.Meta, data: { href: 'https://app.example.com/b' }, timestamp: 180 },
]

describe('computeChunkMeta', () => {
  it('derives index fields purely from the event stream', () => {
    const meta = computeChunkMeta(3, events, 'user-42')
    expect(meta).toEqual({
      seq: 3,
      firstTimestamp: 100,
      lastTimestamp: 180,
      eventCount: events.length,
      clickCount: 2,
      keypressCount: 1,
      errorCount: 1,
      hasFullSnapshot: true,
      urls: ['https://app.example.com/a', 'https://app.example.com/b'],
      traceIds: ['abc'],
      distinctId: 'user-42',
    })
  })

  it('handles an empty chunk', () => {
    const meta = computeChunkMeta(0, [])
    expect(meta.firstTimestamp).toBe(0)
    expect(meta.lastTimestamp).toBe(0)
    expect(meta.eventCount).toBe(0)
    expect(meta.hasFullSnapshot).toBe(false)
    expect(meta.urls).toEqual([])
    expect(meta.distinctId).toBeUndefined()
  })

  it('counts console.error custom events as errors', () => {
    expect(
      computeChunkMeta(0, [
        { type: EventType.Custom, data: { tag: CustomTag.Console, payload: { level: 'error', args: ['x'] } }, timestamp: 1 },
      ]).errorCount
    ).toBe(1)

    expect(
      computeChunkMeta(0, [
        { type: EventType.Custom, data: { tag: CustomTag.Console, payload: { level: 'warn', args: ['x'] } }, timestamp: 1 },
      ]).errorCount
    ).toBe(0)
  })
})
