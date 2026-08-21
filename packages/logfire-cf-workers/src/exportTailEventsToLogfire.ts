import { OTLP_EXPORTER_USER_AGENT } from '@pydantic/otel-cf-workers'
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
  const traceEntries = findTraceEntries(events)
  if (traceEntries.length === 0) {
    return undefined
  }
  // A tail batch carries one payload per producing invocation, and OTLP takes
  // resourceSpans as a repeated field, so merge them into a single request.
  const resourceSpans = traceEntries.flatMap((entry) => {
    const spans = entry['resourceSpans']
    return Array.isArray(spans) ? (spans as unknown[]) : []
  })

  try {
    return await fetch(`${url}/v1/traces`, {
      body: JSON.stringify({ resourceSpans }),
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': `${USER_AGENT} ${OTLP_EXPORTER_USER_AGENT}`,
      },
      method: 'POST',
    })
  } catch (e) {
    console.error(e)
    return undefined
  }
}

function findTraceEntries(events: TraceItem[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const event of events) {
    for (const log of event.logs) {
      if (Array.isArray(log.message)) {
        for (const entry of log.message) {
          if (isTraceEntry(entry)) {
            entries.push(entry)
          }
        }
      }
    }
  }
  return entries
}

function isTraceEntry(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === 'object' && entry !== null && 'resourceSpans' in entry
}
