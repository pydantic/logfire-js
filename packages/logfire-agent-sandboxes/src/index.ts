/**
 * Connects Node.js applications to Logfire Agent Sandboxes through Monty's remote pool.
 * `agentSandboxes` accepts `AgentSandboxesOptions`, adds authentication and tracing,
 * validates the server URL, and adds Logfire troubleshooting hints to checkout refusals.
 */
import type { MontyRemoteOptions } from '@pydantic/monty'

import { context, propagation } from '@opentelemetry/api'
import { MontyRefusedError, MontyRemote } from '@pydantic/monty'
import { resolveBaseUrl } from 'logfire'

import { agentSandboxesUrl } from './url'

export interface AgentSandboxesOptions extends MontyRemoteOptions {
  /**
   * A Logfire API key with the `project:execute_agent_sandboxes` scope.
   * Defaults to the `LOGFIRE_API_KEY` environment variable.
   */
  apiKey?: string
  /**
   * The `https://` or `http://` URL of the sandboxes server, with no path, query, or fragment.
   * Defaults to the Logfire region the API key belongs to, or `LOGFIRE_BASE_URL` when set.
   */
  url?: string
}

type Metadata = () => Record<string, string> | Promise<Record<string, string>>

/**
 * Connects to Logfire Agent Sandboxes, remote Pydantic Monty workers hosted by Logfire.
 *
 * Resolves to a `MontyRemote` pool from `@pydantic/monty`; check out sessions from it:
 *
 * ```ts
 * await using pool = await agentSandboxes()
 * await using session = await pool.checkout()
 * const result = await session.feedRun('1 + 1') // 2
 * ```
 *
 * No connection is made until a session is checked out. The current trace context is sent
 * with each checkout, so the spans Logfire records for the session join the caller's trace.
 * Checkout refusals keep their `MontyRefusedError` class and server details, with Logfire hints
 * for authentication, permissions, and capacity. Invalid URLs are rejected before checkout.
 *
 * Omitted pool options use the defaults of the installed `@pydantic/monty` version.
 * `metadata` results (or those of `connectHeaders`, its deprecated former name) are merged over
 * the Logfire `authorization` metadata and win on conflicts. Names match case-insensitively.
 */
export async function agentSandboxes(options: AgentSandboxesOptions = {}): Promise<MontyRemote> {
  const { apiKey: passedApiKey, connectHeaders, metadata: passedMetadata, url: passedUrl, ...poolOptions } = options
  const apiKey = [passedApiKey, process.env['LOGFIRE_API_KEY']].find((key) => key !== undefined && key !== '')
  if (apiKey === undefined) {
    throw new Error(
      'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
        'Set the LOGFIRE_API_KEY environment variable or pass `apiKey` to `agentSandboxes()`.'
    )
  }
  if (passedMetadata !== undefined && connectHeaders !== undefined) {
    throw new TypeError('pass metadata, not connectHeaders as well')
  }
  const userMetadata: Metadata | undefined = passedMetadata ?? connectHeaders
  const url = agentSandboxesUrl(passedUrl ?? resolveBaseUrl(process.env, undefined, apiKey))

  const metadata = async (): Promise<Record<string, string>> => {
    const carrier: Record<string, string> = {}
    propagation.inject(context.active(), carrier)
    carrier['authorization'] = `Bearer ${apiKey}`
    const result = lowercaseNames(carrier)
    // gRPC metadata names are lowercase, so lowercasing the user's names lets them replace the Logfire entries.
    return userMetadata === undefined ? result : { ...result, ...lowercaseNames(await userMetadata()) }
  }

  const pool = await MontyRemote.create(url, { ...poolOptions, metadata })
  const checkout = pool.checkout.bind(pool)
  pool.checkout = async (...args) => {
    try {
      return await checkout(...args)
    } catch (error) {
      throw logfireRefusal(error)
    }
  }
  return pool
}

function logfireRefusal(error: unknown): unknown {
  if (!(error instanceof MontyRefusedError)) {
    return error
  }
  const hint =
    error.statusCode === 'UNAUTHENTICATED' || error.statusCode === 'PERMISSION_DENIED'
      ? 'Use a project API key (not a personal API key) with the `project:execute_agent_sandboxes` scope. ' +
        "Check that the key's region matches the URL and that Agent Sandboxes are enabled for the project."
      : error.cause === 'caller_cap'
        ? 'Too many sessions are being opened at once. Lower `maxProcesses` or retry after a delay.'
        : error.cause === 'capacity'
          ? 'The service is at capacity. Retry after a delay.'
          : undefined
  if (hint === undefined) {
    return error
  }
  return new MontyRefusedError(`${error.display('msg')}\n\nLogfire Agent Sandboxes: ${hint}`, {
    ...(error.statusCode === null ? {} : { statusCode: error.statusCode }),
    ...(error.statusMessage === null ? {} : { statusMessage: error.statusMessage }),
    ...(error.cause === null ? {} : { cause: error.cause }),
  })
}

function lowercaseNames(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([name, value]) => [name.toLowerCase(), value]))
}
