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

const RECENT_ACTIVITY_WINDOW_MS = 30_000
const DEEP_IDLE_THRESHOLD_MS = 5 * 60_000
const IDLE_FLUSH_INTERVAL_MS = 60_000
const DEEP_IDLE_FLUSH_INTERVAL_MS = 5 * 60_000

export function isUserActivityEvent(event: RrwebEvent): boolean {
  if (event.type !== EventType.IncrementalSnapshot || typeof event.data !== 'object' || event.data === null || !('source' in event.data)) {
    return false
  }
  return typeof event.data.source === 'number' && USER_ACTIVITY_SOURCES.has(event.data.source)
}

export function resolveFlushInterval(configuredIntervalMs: number, inactivityMs: number): number {
  if (inactivityMs < RECENT_ACTIVITY_WINDOW_MS) {
    return configuredIntervalMs
  }
  if (inactivityMs < DEEP_IDLE_THRESHOLD_MS) {
    return Math.max(configuredIntervalMs, IDLE_FLUSH_INTERVAL_MS)
  }
  return Math.max(configuredIntervalMs, DEEP_IDLE_FLUSH_INTERVAL_MS)
}
