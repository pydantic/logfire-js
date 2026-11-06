import { MontyDisconnectError, MontyRefusedError, MontyRemote } from '@pydantic/monty'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentSandboxConnectionError, AgentSandboxError, AgentSandboxRefusedError, agentSandboxes } from './index'

const URL = 'https://logfire-us.pydantic.dev'
const AUTH_HINT =
  'Use a project API key (not a personal API key) with the `project:execute_agent_sandboxes` scope. ' +
  "Check that the key's region matches the URL and that Agent Sandboxes are enabled for the project."
const DISCONNECT_ERROR = new MontyDisconnectError('connection closed while waiting for a reply')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkout refusals', () => {
  /** Authentication refusals need all four checks, while the original Monty error must remain discoverable through cause. */
  it.each(['UNAUTHENTICATED', 'PERMISSION_DENIED'])('wraps %s and preserves the original refusal', async (statusCode) => {
    const message = `failed to spawn monty worker: ${URL}: ${statusCode}: unauthenticated`
    const original = new MontyRefusedError(message, { cause: 'unauthenticated', statusCode, statusMessage: 'unauthenticated' })
    const originalMessage = original.message
    const checkout = vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: URL })
    const error = await pool.checkout({ ephemeral: true }).catch((error: unknown) => error)
    expect(pool).toBeInstanceOf(MontyRemote)
    expect(checkout).toHaveBeenCalledExactlyOnceWith({ ephemeral: true })
    expect(error).toBeInstanceOf(AgentSandboxError)
    expect(error).toBeInstanceOf(AgentSandboxRefusedError)
    expect(error).not.toBeInstanceOf(MontyRefusedError)
    expect(error).toMatchObject({ reason: 'unauthenticated', statusCode, statusMessage: 'unauthenticated' })
    expect((error as Error).cause).toBe(original)
    expect(String(error)).toBe(`AgentSandboxRefusedError: Agent Sandboxes refused the session: unauthenticated\n${AUTH_HINT}`)
    expect(original.message).toBe(originalMessage)
    expect(original.cause).toBe('unauthenticated')
  })

  /** Capacity hints distinguish this caller's burst from service capacity without turning the policy reason into Error.cause. */
  it.each([
    [
      'caller_cap',
      'assignment attempt rate exceeded',
      'Too many sessions are being opened at once. Lower `maxProcesses` or retry after a delay.',
    ],
    ['capacity', 'at capacity', 'The service is at capacity. Retry after a delay.'],
  ])('wraps %s with a targeted hint', async (reason, statusMessage, hint) => {
    const original = new MontyRefusedError('transport refusal', { cause: reason, statusCode: 'RESOURCE_EXHAUSTED', statusMessage })
    vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: URL })
    const error = await pool.checkout().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AgentSandboxRefusedError)
    expect(error).toMatchObject({ reason, statusCode: 'RESOURCE_EXHAUSTED', statusMessage })
    expect((error as Error).cause).toBe(original)
    expect(String(error)).toBe(`AgentSandboxRefusedError: Agent Sandboxes refused the session: ${statusMessage}\n${hint}`)
  })

  /** Refusals without a recognized hint still belong to the public refusal class, regardless of Monty's message wording. */
  it.each([
    `failed to spawn monty worker: ${URL}: UNAVAILABLE: worker unavailable`,
    `${URL} refused the session: UNAVAILABLE: worker unavailable`,
  ])('wraps an unhinted refusal: %s', async (message) => {
    const original = new MontyRefusedError(message, {
      cause: 'worker_unavailable',
      statusCode: 'UNAVAILABLE',
      statusMessage: 'worker unavailable',
    })
    vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: URL })
    const error = await pool.checkout().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AgentSandboxRefusedError)
    expect(error).toMatchObject({ reason: 'worker_unavailable', statusCode: 'UNAVAILABLE', statusMessage: 'worker unavailable' })
    expect((error as Error).cause).toBe(original)
    expect(String(error)).toBe('AgentSandboxRefusedError: Agent Sandboxes refused the session: worker unavailable')
  })

  /** Absent server details remain null rather than leaking Monty implementation text into the outer error. */
  it('preserves missing refusal details', async () => {
    const original = new MontyRefusedError('legacy refusal')
    vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: URL })
    const error = await pool.checkout().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AgentSandboxRefusedError)
    expect(error).toMatchObject({ reason: null, statusCode: null, statusMessage: null })
    expect((error as Error).cause).toBe(original)
    expect(String(error)).toBe('AgentSandboxRefusedError: Agent Sandboxes refused the session: no server status message')
  })
})

describe.each(['create', 'checkout'] as const)('%s failures', (phase) => {
  /** Every connection or checkout failure needs a public SDK error and the exact original cause, even without a hint. */
  it.each([
    [new Error(`failed to spawn monty worker: ${URL}: connect timed out after 10s`), 'connect timed out after 10s'],
    [
      new Error(`failed to spawn monty worker: ${URL}: not a gRPC server, the response's content-type is text/html`),
      "not a gRPC server, the response's content-type is text/html",
    ],
    [new Error(`${URL}: TLS certificate verification failed`), 'TLS certificate verification failed'],
    [new Error('DNS resolution failed'), 'DNS resolution failed'],
    [new DOMException('checkout timed out', 'TimeoutError'), 'checkout timed out'],
    [DISCONNECT_ERROR, DISCONNECT_ERROR.message],
    ['non-Error failure', 'non-Error failure'],
    [null, 'null'],
  ])('wraps %s', async (original, message) => {
    if (phase === 'create') {
      vi.spyOn(MontyRemote, 'create').mockRejectedValue(original)
    } else {
      vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    }
    const operation = async (): Promise<void> => {
      await using pool = await agentSandboxes({ apiKey: 'test-key', url: URL })
      await pool.checkout()
    }
    const error = await operation().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AgentSandboxError)
    expect(error).toBeInstanceOf(AgentSandboxConnectionError)
    expect((error as Error).cause).toBe(original)
    expect(String(error)).toBe(`AgentSandboxConnectionError: Agent Sandboxes could not connect to ${URL}: ${message}`)
  })

  /** The refusal classification must not depend on whether the client reports it during creation or checkout. */
  it('classifies a refusal separately from connection failures', async () => {
    const original = new MontyRefusedError('refused', { statusCode: 'PERMISSION_DENIED', statusMessage: 'access denied' })
    if (phase === 'create') {
      vi.spyOn(MontyRemote, 'create').mockRejectedValue(original)
    } else {
      vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    }
    const operation = async (): Promise<void> => {
      await using pool = await agentSandboxes({ apiKey: 'test-key', url: URL })
      await pool.checkout()
    }
    const error = await operation().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AgentSandboxRefusedError)
    expect((error as Error).cause).toBe(original)
    expect(String(error)).toBe(`AgentSandboxRefusedError: Agent Sandboxes refused the session: access denied\n${AUTH_HINT}`)
  })
})

/** Metadata callbacks run at checkout, so their failures need the same connection wrapper without opening a stream. */
it('wraps metadata callback failures', async () => {
  const original = new Error('metadata callback failed')
  await using pool = await agentSandboxes({
    apiKey: 'test-key',
    metadata: () => {
      throw original
    },
    url: URL,
  })
  const error = await pool.checkout().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(AgentSandboxConnectionError)
  expect((error as Error).cause).toBe(original)
  expect(String(error)).toBe(`AgentSandboxConnectionError: Agent Sandboxes could not connect to ${URL}: metadata callback failed`)
})

/** Consumers can catch the exported base class and use standard Error.cause semantics for their own context. */
it('exports a standard Error base class', () => {
  const cause = new Error('inner context')
  const error = new AgentSandboxError('Agent Sandboxes configuration failed', { cause })
  expect(error).toBeInstanceOf(Error)
  expect(error.cause).toBe(cause)
  expect(String(error)).toBe('AgentSandboxError: Agent Sandboxes configuration failed')
})
