import type { MontyWebsocketOptions } from '@pydantic/monty'

import { context, propagation } from '@opentelemetry/api'
import { MontyWebsocket } from '@pydantic/monty'
import { resolveBaseUrl } from 'logfire'

import { agentSandboxesUrl } from './url'

export interface AgentSandboxesOptions extends MontyWebsocketOptions {
  /**
   * A Logfire API key with the `project:execute_agent_sandboxes` scope.
   * Defaults to the `LOGFIRE_API_KEY` environment variable.
   */
  apiKey?: string
  /**
   * The WebSocket URL of the sandboxes server.
   * Defaults to the Logfire region the API key belongs to, or `LOGFIRE_BASE_URL` when set.
   */
  url?: string
}

/**
 * Connects to Logfire Agent Sandboxes, remote Pydantic Monty workers hosted by Logfire.
 *
 * Resolves to a `MontyWebsocket` pool from `@pydantic/monty`; check out sessions from it:
 *
 * ```ts
 * await using pool = await agentSandboxes()
 * await using session = await pool.checkout()
 * const result = await session.feedRun('1 + 1') // 2
 * ```
 *
 * No connection is made until a session is checked out. The current trace context is sent
 * with each checkout, so the spans Logfire records for the session join the caller's trace.
 *
 * Omitted pool options use the defaults of the installed `@pydantic/monty` version.
 * `connectHeaders` results are merged over the Logfire `Authorization` header and win on conflicts.
 */
export async function agentSandboxes(options: AgentSandboxesOptions = {}): Promise<MontyWebsocket> {
  const { apiKey: passedApiKey, connectHeaders, url: passedUrl, ...poolOptions } = options
  const apiKey = [passedApiKey, process.env['LOGFIRE_API_KEY']].find((key) => key !== undefined && key !== '')
  if (apiKey === undefined) {
    throw new Error(
      'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
        'Set the LOGFIRE_API_KEY environment variable or pass `apiKey` to `agentSandboxes()`.'
    )
  }
  const url = passedUrl ?? agentSandboxesUrl(resolveBaseUrl(process.env, undefined, apiKey))

  const headers = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    propagation.inject(context.active(), result)
    result['authorization'] = `Bearer ${apiKey}`
    // Monty matches header names case-insensitively and keeps the last value, so user headers come last to win.
    return connectHeaders === undefined ? result : { ...result, ...(await connectHeaders()) }
  }

  return MontyWebsocket.create(url, { ...poolOptions, connectHeaders: headers })
}
