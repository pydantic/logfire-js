/**
 * Public errors for applications that connect to Logfire Agent Sandboxes.
 * `AgentSandboxError` covers SDK configuration failures; its refusal and connection
 * subclasses preserve the original checkout or connection failure on `Error.cause`.
 * Errors raised by operations on an established session are not wrapped.
 */
import type { MontyRefusedError } from '@pydantic/monty'

/** Base class for Agent Sandboxes SDK errors. */
export class AgentSandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentSandboxError'
  }
}

/** The server refused a checkout; no sandbox code ran. The original refusal is `cause`. */
export class AgentSandboxRefusedError extends AgentSandboxError {
  readonly statusCode: string | null
  readonly statusMessage: string | null
  readonly reason: string | null

  constructor(cause: MontyRefusedError) {
    const message = `Agent Sandboxes refused the session: ${cause.statusMessage ?? 'no server status message'}`
    const hint = refusalHint(cause)
    super(hint === undefined ? message : `${message}\n${hint}`, { cause })
    this.name = 'AgentSandboxRefusedError'
    this.statusCode = cause.statusCode
    this.statusMessage = cause.statusMessage
    this.reason = cause.cause
  }
}

/** A pool could not be created or checked out. The original failure is `cause`. */
export class AgentSandboxConnectionError extends AgentSandboxError {
  constructor(url: string, cause: unknown) {
    const message = (cause instanceof Error ? cause.message : String(cause)).replace(/^failed to spawn monty worker: /u, '')
    const prefix = `${url}: `
    super(`Agent Sandboxes could not connect to ${url}: ${message.startsWith(prefix) ? message.slice(prefix.length) : message}`, { cause })
    this.name = 'AgentSandboxConnectionError'
  }
}

function refusalHint(error: MontyRefusedError): string | undefined {
  return error.statusCode === 'UNAUTHENTICATED' || error.statusCode === 'PERMISSION_DENIED'
    ? 'Use a project API key (not a personal API key) with the `project:execute_agent_sandboxes` scope. ' +
        "Check that the key's region matches the URL and that Agent Sandboxes are enabled for the project."
    : error.cause === 'caller_cap'
      ? 'Too many sessions are being opened at once. Lower `maxProcesses` or retry after a delay.'
      : error.cause === 'capacity'
        ? 'The service is at capacity. Retry after a delay.'
        : undefined
}
