import { CustomTag, EventType, IncrementalSource, MouseInteractions } from './types'
import type { ChunkMeta, ReplayUser, RrwebEvent, SessionAttributes } from './types'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Copies only the documented fields so arbitrary application user data never reaches replay metadata.
export function normalizeReplayUser(value: unknown): ReplayUser | undefined {
  const record = asRecord(value)
  const id = asString(record?.['id'])
  if (record === undefined || id === undefined) {
    return undefined
  }
  const name = asString(record['name'])
  const email = asString(record['email'])
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
  }
}

export function computeChunkMeta(
  seq: number,
  events: RrwebEvent[],
  distinctId?: string,
  sessionAttributes: SessionAttributes = {},
  user?: ReplayUser
): ChunkMeta {
  let firstTimestamp = Number.POSITIVE_INFINITY
  let lastTimestamp = 0
  let clickCount = 0
  let keypressCount = 0
  let errorCount = 0
  let hasFullSnapshot = false
  const urls = new Set<string>()

  for (const event of events) {
    if (event.timestamp < firstTimestamp) {
      firstTimestamp = event.timestamp
    }
    if (event.timestamp > lastTimestamp) {
      lastTimestamp = event.timestamp
    }

    const data = asRecord(event.data)
    if (event.type === EventType.FullSnapshot) {
      hasFullSnapshot = true
    } else if (event.type === EventType.Meta) {
      const href = asString(data?.['href'])
      if (href !== undefined) {
        urls.add(href)
      }
    } else if (event.type === EventType.IncrementalSnapshot && data !== undefined) {
      const source = data['source']
      if (source === IncrementalSource.MouseInteraction) {
        const kind = data['type']
        if (kind === MouseInteractions.Click || kind === MouseInteractions.DblClick) {
          clickCount++
        }
      } else if (source === IncrementalSource.Input) {
        keypressCount++
      }
    } else if (event.type === EventType.Custom && data !== undefined) {
      const tag = asString(data['tag'])
      const payload = asRecord(data['payload'])
      if (tag === CustomTag.Error) {
        errorCount++
      } else if (tag === CustomTag.Console) {
        if (payload?.['level'] === 'error') {
          errorCount++
        }
      } else if (tag === CustomTag.Navigation) {
        const url = asString(payload?.['url'])
        if (url !== undefined) {
          urls.add(url)
        }
      }
    }
  }

  return {
    seq,
    firstTimestamp: firstTimestamp === Number.POSITIVE_INFINITY ? 0 : firstTimestamp,
    lastTimestamp,
    eventCount: events.length,
    clickCount,
    keypressCount,
    errorCount,
    hasFullSnapshot,
    urls: [...urls],
    ...(distinctId !== undefined && distinctId.length > 0 ? { distinctId } : {}),
    ...(user === undefined ? {} : { user: { ...user } }),
    ...(Object.keys(sessionAttributes).length === 0 ? {} : { sessionAttributes: { ...sessionAttributes } }),
  }
}
