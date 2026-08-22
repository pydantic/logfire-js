import { EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

const USER_ACTIVITY_SOURCES = new Set<number>([
  IncrementalSource.MouseMove,
  IncrementalSource.MouseInteraction,
  IncrementalSource.Scroll,
  IncrementalSource.ViewportResize,
  IncrementalSource.Input,
  IncrementalSource.TouchMove,
  IncrementalSource.MediaInteraction,
  IncrementalSource.Drag,
  IncrementalSource.Selection,
])

export function isUserActivityEvent(event: RrwebEvent): boolean {
  if (event.type !== EventType.IncrementalSnapshot || typeof event.data !== 'object' || event.data === null || !('source' in event.data)) {
    return false
  }
  return typeof event.data.source === 'number' && USER_ACTIVITY_SOURCES.has(event.data.source)
}
