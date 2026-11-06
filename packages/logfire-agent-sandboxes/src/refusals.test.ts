import { MontyDisconnectError, MontyRefusedError, MontyRemote } from '@pydantic/monty'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentSandboxes } from './index'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkout refusals', () => {
  /** Authentication refusals need all four checks because the server does not distinguish these configuration errors. */
  it.each(['UNAUTHENTICATED', 'PERMISSION_DENIED'])('adds configuration hints to %s without losing server details', async (statusCode) => {
    const message = `failed to spawn monty worker: https://logfire-us.pydantic.dev: ${statusCode}: unauthenticated`
    const details = { cause: 'unauthenticated', statusCode, statusMessage: 'unauthenticated' }
    const original = new MontyRefusedError(message, details)
    const checkout = vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: 'https://logfire-us.pydantic.dev' })
    const error = await pool.checkout({ ephemeral: true }).catch((error: unknown) => error)
    expect(pool).toBeInstanceOf(MontyRemote)
    expect(checkout).toHaveBeenCalledExactlyOnceWith({ ephemeral: true })
    expect(error).toBeInstanceOf(MontyRefusedError)
    expect(error).toMatchObject(details)
    const expectedMessage =
      `${message}\n\nLogfire Agent Sandboxes: ` +
      'Use a project API key (not a personal API key) with the `project:execute_agent_sandboxes` scope. ' +
      "Check that the key's region matches the URL and that Agent Sandboxes are enabled for the project."
    expect(error).toEqual(new MontyRefusedError(expectedMessage, details))
    expect(String(error)).toBe(`MontyRefusedError: RuntimeError: ${expectedMessage}`)
    expect((error as MontyRefusedError).display('msg')).toBe(expectedMessage)
    expect(original.message).toBe(`RuntimeError: ${message}`)
  })

  /** A refusal cause is a policy string, not an Error chain; capacity hints must preserve that string. */
  it.each([
    [
      'caller_cap',
      'assignment attempt rate exceeded',
      'Too many sessions are being opened at once. Lower `maxProcesses` or retry after a delay.',
    ],
    ['capacity', 'at capacity', 'The service is at capacity. Retry after a delay.'],
  ])('adds a targeted hint for %s', async (cause, statusMessage, hint) => {
    const message = `failed to spawn monty worker: https://logfire-us.pydantic.dev: RESOURCE_EXHAUSTED: ${statusMessage}`
    const details = { cause, statusCode: 'RESOURCE_EXHAUSTED', statusMessage }
    vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(new MontyRefusedError(message, details))
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: 'https://logfire-us.pydantic.dev' })
    const result = pool.checkout()
    await expect(result).rejects.toEqual(new MontyRefusedError(`${message}\n\nLogfire Agent Sandboxes: ${hint}`, details))
    await expect(result).rejects.toMatchObject(details)
  })

  /** Older servers can omit optional refusal details, which must remain null after adding a hint. */
  it('preserves missing status message and cause', async () => {
    vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(new MontyRefusedError('denied', { statusCode: 'PERMISSION_DENIED' }))
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: 'https://logfire-us.pydantic.dev' })
    await expect(pool.checkout()).rejects.toMatchObject({ cause: null, statusCode: 'PERMISSION_DENIED', statusMessage: null })
  })

  /** Unrecognized refusals and non-refusal failures must pass through unchanged, not acquire misleading configuration hints. */
  it.each([
    new MontyRefusedError('worker unavailable', { cause: 'worker_unavailable', statusCode: 'UNAVAILABLE' }),
    new MontyRefusedError('unknown refusal'),
    new MontyDisconnectError('connection closed while waiting for a reply', { cause: 'capacity' }),
    new Error('connect timed out'),
    new DOMException('checkout timed out', 'TimeoutError'),
  ])('passes through $name: $message', async (original) => {
    vi.spyOn(MontyRemote.prototype, 'checkout').mockRejectedValue(original)
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: 'https://logfire-us.pydantic.dev' })
    await expect(pool.checkout()).rejects.toBe(original)
  })
})
