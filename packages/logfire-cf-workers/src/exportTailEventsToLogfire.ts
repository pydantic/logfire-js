import { resolveBaseUrl } from 'logfire'

import { USER_AGENT } from './userAgent'

// simplified interface from CF
export interface TraceItem {
  logs: { message: unknown[] }[]
}

export async function exportTailEventsToLogfire(
  events: TraceItem[],
  env: Record<string, string | undefined>
): Promise<Response | undefined> {
  const token = env['LOGFIRE_TOKEN']
  if (token === undefined || token === '') {
    console.warn('No token provided, not sending payload to Logfire')
    return undefined
  }
  const url = resolveBaseUrl(env, undefined, token)
  const traceEntry = findTraceEntry(events)
  if (traceEntry === null) {
    return undefined
  }

  try {
    return await fetch(`${url}/v1/traces`, {
      body: JSON.stringify(traceEntry),
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      method: 'POST',
    })
  } catch (e) {
    console.error(e)
    return undefined
  }
}

function findTraceEntry(events: TraceItem[]): Record<string, unknown> | null {
  for (const event of events) {
    for (const log of event.logs) {
      if (Array.isArray(log.message)) {
        for (const entry of log.message) {
          if (isTraceEntry(entry)) {
            return entry
          }
        }
      }
    }
  }
  return null
}

function isTraceEntry(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === 'object' && entry !== null && 'resourceSpans' in entry
}
