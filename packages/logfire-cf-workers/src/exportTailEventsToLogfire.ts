import { resolveBaseUrl } from '@pydantic/logfire-api'

// simplified interface from CF
export interface TraceItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logs: { message: any[] }[]
}

export async function exportTailEventsToLogfire(events: TraceItem[], env: Record<string, string | undefined>) {
  const token = env.LOGFIRE_TOKEN
  if (!token) {
    console.warn('No token provided, not sending payload to Logfire')
    return
  }
  const url = resolveBaseUrl(env, undefined, token)

  for (const event of events) {
    for (const log of event.logs) {
      if (Array.isArray(log.message)) {
        for (const entry of log.message) {
          if ('resourceSpans' in entry) {
            try {
              return await fetch(`${url}/v1/traces`, {
                body: JSON.stringify(entry),
                headers: {
                  Authorization: token,
                  'Content-Type': 'application/json',
                },
                method: 'POST',
              })
            } catch (e) {
              console.error(e)
            }
          }
        }
      }
    }
  }
}
