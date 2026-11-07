/** Code mode callers receive the same routing for raw errors and errors wrapped by Agent Sandboxes. */
import type { MontySession } from '@pydantic/monty'
import type { StreamTextOnErrorCallback } from 'ai'

import {
  Monty,
  MontyCrashedError,
  MontyDisconnectError,
  MontyRefusedError,
  MontyRuntimeError,
  MontyShutdown,
  MontySyntaxError,
  MontyTypingError,
} from '@pydantic/monty'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import type { Sandboxes } from './codeMode'

import { codeMode } from './codeMode'
import { CountingSandboxes, runCode, runCodeError } from './testing'

let pool: Monty

beforeAll(async () => {
  pool = await Monty.create({ maxProcesses: 4 })
})

afterAll(async () => {
  await pool.close()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function wrap(error: Error, depth = 1): Error {
  return Array.from({ length: depth }).reduce<Error>((cause) => new Error('Agent Sandboxes request failed', { cause }), error)
}

describe('wrapped checkout errors', () => {
  /** A refused checkout has not run code, so its structured capacity cause still permits exactly one retry through wrappers. */
  test.each(['caller_cap', 'capacity', 'worker_unavailable'])('retries wrapped %s once', async (cause) => {
    vi.useFakeTimers()
    const error = wrap(new MontyRefusedError('Agent Sandboxes is busy', { statusCode: 'RESOURCE_EXHAUSTED', cause }), 3)
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    const onError = vi.fn<StreamTextOnErrorCallback>()
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() }, onError })
    const failed = runCode(code, { code: '1' }).catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(99)
    expect(checkout).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await failed).toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(checkout.mock.calls[1]).toEqual(checkout.mock.calls[0])
    expect(onError.mock.calls).toEqual([[{ error }]])
  })

  /** Authentication and permission refusals never become retryable merely because the service wraps them or attaches a capacity cause. */
  test.each(['UNAUTHENTICATED', 'PERMISSION_DENIED'])('never retries wrapped %s', async (statusCode) => {
    const error = wrap(new MontyRefusedError('Agent Sandboxes access denied', { statusCode, cause: 'capacity' }))
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** Walking at most eight Error objects handles ordinary wrappers without trusting unbounded or cyclic cause chains. */
  test.each([
    [7, 2],
    [8, 1],
  ])('bounds a chain with %i wrappers to %i checkout attempts', async (depth, attempts) => {
    vi.useFakeTimers()
    const error = wrap(new MontyRefusedError('Agent Sandboxes is busy', { cause: 'capacity' }), depth)
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const failed = runCode(code, { code: '1' }).catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(100)
    expect(await failed).toBe(error)
    expect(checkout).toHaveBeenCalledTimes(attempts)
  })

  /** Error.cause is not always an Error; arbitrary objects and strings must not be traversed or parsed as retry instructions. */
  test.each(['capacity', { cause: new MontyRefusedError('Agent Sandboxes is busy', { cause: 'capacity' }) }])(
    'stops at non-Error cause %j',
    async (cause) => {
      const error = new Error('Agent Sandboxes connection failed', { cause })
      const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
      await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
      await expect(runCode(code, { code: '1' })).rejects.toBe(error)
      expect(checkout).toHaveBeenCalledTimes(1)
    }
  )

  /** A cyclic wrapper cannot hang classification, and the developer must still receive the exact original error. */
  test('terminates a cyclic cause chain', async () => {
    const error = new Error('Agent Sandboxes connection failed')
    error.cause = error
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(1)
  })
})

describe('wrapped execution errors', () => {
  /** A wrapped syntax or type failure has not passed type checking, so first-snippet checking must remain enabled. */
  test.each([new MontySyntaxError('invalid syntax'), new MontyTypingError('invalid type')])(
    'keeps type checking after wrapped %s',
    async (error) => {
      const session = await pool.checkout({ typeCheck: true })
      const feed = vi.spyOn(session, 'feedRun').mockRejectedValueOnce(wrap(error))
      const checkout = vi.fn<Sandboxes['checkout']>().mockResolvedValue(session)
      await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
      await runCodeError(code, { code: '1' })
      expect(await runCode(code, { code: '2' })).toBe(2)
      expect(feed).toHaveBeenNthCalledWith(2, '2', expect.objectContaining({ skipTypeCheck: false }))
      expect(checkout).toHaveBeenCalledTimes(1)
    }
  )

  /** Wrappers must not change timeout, lost-state, crash or Python-error guidance, nor whether a failure loses the session. */
  test.each([
    new MontyCrashedError('Agent Sandboxes request expired', { timedOut: true }),
    new MontyCrashedError('Agent Sandboxes worker exited'),
    new MontyDisconnectError('Agent Sandboxes stream ended', { cause: 'turn_timeout' }),
    new MontyDisconnectError('Agent Sandboxes stream ended', { cause: 'session_timeout' }),
    new MontyDisconnectError('Agent Sandboxes stream ended', { cause: 'idle_timeout' }),
    new MontyDisconnectError('Agent Sandboxes stream ended'),
    new MontyDisconnectError('Agent Sandboxes stream ended', { cause: 'unknown_cause' }),
    new MontySyntaxError('invalid syntax'),
    new MontyTypingError('invalid type'),
    new MontyRuntimeError('ZeroDivisionError', 'division by zero'),
  ])('matches raw routing for %s', async (error) => {
    const outcomes = await Promise.all(
      [error, wrap(error, 3)].map(async (failure) => {
        const counted = new CountingSandboxes(pool)
        await using code = codeMode({ tools: {}, sandboxes: counted })
        await runCode(code, { code: 'kept = 1' })
        const session = counted.sessions[0] as MontySession
        vi.spyOn(session, 'feedRun').mockRejectedValueOnce(failure)
        const message = await runCodeError(code, { code: '1' })
        await runCode(code, { code: '2' })
        return { message, sessions: counted.sessions.length }
      })
    )
    expect(outcomes[1]).toEqual(outcomes[0])
  })

  /** Missing and unrecognized disconnect causes, raw or wrapped, must lose the session without latching a developer failure or replaying. */
  test.each([
    { depth: 0, cause: undefined },
    { depth: 0, cause: 'unknown_cause' },
    { depth: 3, cause: undefined },
    { depth: 3, cause: 'unknown_cause' },
  ])('resets on disconnect cause $cause through $depth wrappers', async ({ depth, cause }) => {
    const counted = new CountingSandboxes(pool)
    const onError = vi.fn<StreamTextOnErrorCallback>()
    await using code = codeMode({ tools: {}, sandboxes: counted, onError })
    await runCode(code, { code: 'kept = 1' })
    const session = counted.sessions[0] as MontySession
    const error = wrap(new MontyDisconnectError('Agent Sandboxes stream ended', cause === undefined ? undefined : { cause }), depth)
    const close = vi.spyOn(session, 'close')
    const feed = vi.spyOn(session, 'feedRun').mockRejectedValueOnce(error)
    expect(await runCodeError(code, { code: '2' })).toBe(
      'The sandbox session ended unexpectedly and its state was lost. Recreate any state you need. ' +
        'Check any tool calls already started before continuing, and do not replay completed side effects.'
    )
    expect(close).toHaveBeenCalledTimes(1)
    expect(feed).toHaveBeenCalledTimes(1)
    expect(counted.sessions).toHaveLength(1)
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/Name `kept` used when not defined/u)
    expect(counted.sessions).toHaveLength(2)
    expect(counted.sessions[1]).not.toBe(session)
    expect(await runCode(code, { code: '2' })).toBe(2)
    expect(onError).not.toHaveBeenCalled()
  })

  /** A wrapped drain has the same did-not-run guarantee and must replay once without extending the snippet deadline. */
  test('replays a wrapped shutdown on a fresh session', async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted })
    await runCode(code, { code: 'kept = 1' })
    const session = counted.sessions[0] as MontySession
    const close = vi.spyOn(session, 'close')
    vi.spyOn(session, 'feedRun').mockRejectedValueOnce(wrap(new MontyShutdown('Agent Sandboxes server restarting'), 3))
    expect(await runCode(code, { code: '2 + 2' })).toEqual({
      result: 4,
      sessionReset:
        'The sandbox session was replaced. Variables, imports and definitions from earlier calls are gone. ' +
        'Recreate any state you need, but do not replay completed side effects.',
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(counted.sessions).toHaveLength(2)
  })

  /** Repeated wrapped drains still end the run after one replacement session, rather than silently looping. */
  test('surfaces the second wrapped shutdown', async () => {
    const error = wrap(new MontyShutdown('Agent Sandboxes server restarting'))
    const checkout = vi.fn<Sandboxes['checkout']>(async (options) => {
      const session = await pool.checkout(options)
      vi.spyOn(session, 'feedRun').mockRejectedValue(error)
      return session
    })
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
  })
})
