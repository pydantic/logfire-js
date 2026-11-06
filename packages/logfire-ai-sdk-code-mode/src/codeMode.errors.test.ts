/** Error routing requirements for AI SDK runs, using local Monty sessions and synthetic remote failures. */
import type { MontySession } from '@pydantic/monty'
import type { StreamTextOnErrorCallback } from 'ai'

import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import { Monty, MontyCrashedError, MontyDisconnectError, MontyRefusedError, MontyShutdown, ProtocolError } from '@pydantic/monty'
import { convertToModelMessages, generateText, stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { Sandboxes } from './codeMode'

import { codeMode } from './codeMode'
import { CountingSandboxes, delay, runCode, runCodeError } from './testing'

vi.mock('@pydantic/logfire-agent-sandboxes', () => ({ agentSandboxes: vi.fn<typeof agentSandboxes>() }))

let pool: Monty

beforeAll(async () => {
  pool = await Monty.create({ maxProcesses: 4 })
})

afterAll(async () => {
  await pool.close()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const call = { type: 'tool-call' as const, toolCallId: 'call', toolName: 'run_code', input: '{"code":"1 + 1"}' }
const finishReason = { unified: 'tool-calls' as const, raw: 'tool-calls' }
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

function callingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => Promise.resolve({ content: [call], finishReason, usage, warnings: [] }),
    doStream: async () =>
      Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue(call)
            controller.enqueue({ type: 'finish', finishReason, usage })
            controller.close()
          },
        }),
      }),
  })
}

function firstSession(counted: CountingSandboxes): MontySession {
  const [session] = counted.sessions
  if (session === undefined) {
    throw new Error('No session was checked out')
  }
  return session
}

const developerErrors = [
  new MontyRefusedError('Invalid sandbox credentials', { statusCode: 'UNAUTHENTICATED', cause: 'unauthenticated' }),
  new MontyRefusedError('Sandbox access denied', { statusCode: 'PERMISSION_DENIED', cause: 'permission_denied' }),
  new Error('Could not dial sandbox.example.invalid'),
  new TypeError('Invalid sandbox URL'),
]

describe('developer errors', () => {
  /** Throwing from execute alone becomes a model tool error; the output hook must reject the whole generateText run. */
  test.each(developerErrors)('generateText surfaces checkout failure: %s', async (error) => {
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    const onToolError = vi.fn<() => undefined>()
    const onError = vi.fn<StreamTextOnErrorCallback>()
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() }, onToolError, onError })
    const model = callingModel()
    await expect(generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })).rejects.toBe(error)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(checkout).toHaveBeenCalledTimes(1)
    expect(onToolError).not.toHaveBeenCalled()
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls).toEqual([[{ error }]])
  })

  /** Infrastructure failures reject stream iteration without an error part or AI SDK onError callback. */
  test.each(developerErrors)('streamText surfaces checkout failure: %s', async (error) => {
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const model = callingModel()
    const onError = vi.fn<() => void>()
    const result = streamText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3), onError })
    const parts: string[] = []
    const consume = async (): Promise<void> => {
      for await (const part of result.fullStream) {
        parts.push(part.type)
      }
    }
    await expect(consume()).rejects.toBe(error)
    expect(parts).toEqual(['start', 'start-step', 'tool-call', 'tool-result', 'finish-step'])
    expect(onError).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(checkout).toHaveBeenCalledTimes(1)
    await code.closeWhenDone(result)
  })

  /** UI routes abort without AI SDK error callbacks, so code mode must report the original error and serialize only a distinct marker. */
  test.each(['raw', 'wrapped'])('keeps the original %s error out of UI message stream responses', async (kind) => {
    const secret = 'synthetic-private-configuration'
    const refusal = new MontyRefusedError(secret, { statusCode: 'UNAUTHENTICATED', statusMessage: secret })
    const error = kind === 'raw' ? refusal : new Error('Agent Sandboxes connection failed', { cause: refusal })
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    const onError = vi.fn<StreamTextOnErrorCallback>()
    const onUIError = vi.fn<() => string>(() => 'The agent run failed.')
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() }, onError })
    const result = streamText({ model: callingModel(), prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3), onError })
    const response = result.toUIMessageStreamResponse({ onError: onUIError })
    const body = response.body
    if (body === null) {
      throw new Error('The UI response has no body')
    }
    const decoder = new TextDecoder()
    let serialized = ''
    const consume = async (): Promise<void> => {
      for await (const chunk of body) {
        serialized += decoder.decode(chunk)
      }
    }
    await expect(consume()).rejects.toBe(error)
    expect(onError.mock.calls).toEqual([[{ error }]])
    expect(onUIError).not.toHaveBeenCalled()
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain('"type":"tool-output-available","toolCallId":"call","output":{"sandboxFailure":true}')
    await code.closeWhenDone(result)
  })

  /** Persisted tool results must distinguish infrastructure failure from successful Python None without exposing developer errors. */
  test.each([
    [{ result: {} }, { type: 'json', value: {} }],
    [{ result: { sandboxFailure: true } }, { type: 'json', value: { sandboxFailure: true } }],
    [
      { sandboxFailure: true },
      {
        type: 'text',
        value: 'Agent Sandboxes infrastructure failed. This call did not complete; a developer must fix the sandbox before a new run.',
      },
    ],
  ])('converts the saved UI output %j correctly', async (output, expected) => {
    await using code = codeMode({ tools: {}, sandboxes: pool })
    const messages = await convertToModelMessages(
      [
        {
          role: 'assistant',
          parts: [{ type: 'tool-run_code', toolCallId: 'call', state: 'output-available', input: { code: '1' }, output }],
        },
      ],
      { tools: code.tools }
    )
    expect(messages[1]?.content).toEqual([{ type: 'tool-result', toolCallId: 'call', toolName: 'run_code', output: expected }])
  })

  /** Every successful result is wrapped for transport and unwrapped for the model, so Python dictionaries cannot collide with failure markers. */
  test.each([
    ['{"sandboxFailure": True}', { sandboxFailure: true }],
    ['{"result": {"sandboxFailure": True}}', { result: { sandboxFailure: true } }],
    ['{}', {}],
    ['None', {}],
    ['"done"', 'done'],
  ])('preserves successful Python output %s live and after UI persistence', async (source, expected) => {
    await using code = codeMode({ tools: {}, sandboxes: pool })
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [{ ...call, input: JSON.stringify({ code: source }) }], finishReason, usage, warnings: [] },
        { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
      ],
    })
    const result = await generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })
    expect(result.text).toBe('done')
    const modelOutput = typeof expected === 'string' ? { type: 'text', value: expected } : { type: 'json', value: expected }
    const content = [{ type: 'tool-result', toolCallId: 'call', toolName: 'run_code', output: modelOutput }]
    expect(model.doGenerateCalls[1]?.prompt.filter((message) => message.role === 'tool')).toEqual([{ role: 'tool', content }])
    const saved = JSON.parse(JSON.stringify(result.steps[0]?.toolResults[0]?.output)) as unknown
    expect(saved).toEqual({ result: expected })
    const messages = await convertToModelMessages(
      [
        {
          role: 'assistant',
          parts: [{ type: 'tool-run_code', toolCallId: 'call', state: 'output-available', input: { code: source }, output: saved }],
        },
      ],
      { tools: code.tools }
    )
    expect(messages[1]?.content).toEqual(content)
  })

  /** Reporting failures must not mask the infrastructure error or turn a logger error into a model tool error. */
  test('reports once even if the developer error handler throws', async () => {
    const error = new Error('synthetic dial failure')
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    const onError = vi.fn<StreamTextOnErrorCallback>(() => {
      throw new Error('synthetic logger failure')
    })
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() }, onError })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(onError.mock.calls).toEqual([[{ error }]])
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** A shared asynchronous onError handler must finish before the run rejects, and queued calls must not report the same failure again. */
  test('awaits onError and reports one event for queued failures', async () => {
    const error = new Error('Agent Sandboxes connection failed')
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    let release!: () => void
    const reported = new Promise<void>((resolve) => {
      release = resolve
    })
    const onError = vi.fn<StreamTextOnErrorCallback>(async () => {
      await reported
    })
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() }, onError })
    let settled = false
    const failed = runCode(code, { code: '1' }).catch((failure: unknown) => {
      settled = true
      return failure
    })
    const queued = runCode(code, { code: '2' }).catch((failure: unknown) => failure)
    await vi.waitFor(() => {
      expect(onError.mock.calls).toEqual([[{ error }]])
    })
    expect(settled).toBe(false)
    release()
    expect(await failed).toBe(error)
    expect(await queued).toBe(error)
    expect(onError.mock.calls).toEqual([[{ error }]])
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** An async reporting failure must not replace the original error or become a model-visible tool error. */
  test('preserves the original error when onError rejects', async () => {
    const error = new Error('Agent Sandboxes connection failed')
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    const onError = vi.fn<StreamTextOnErrorCallback>(async () => {
      await Promise.resolve()
      throw new Error('Agent Sandboxes error reporting failed')
    })
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() }, onError })
    const model = callingModel()
    await expect(generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })).rejects.toBe(error)
    expect(onError.mock.calls).toEqual([[{ error }]])
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  /** Explicit close takes precedence over a latched infrastructure failure, as it does over normal execution. */
  test('rejects calls after closing a failed run as closed', async () => {
    const error = new Error('synthetic dial failure')
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    const code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    await code.close()
    await expect(runCode(code, { code: '1' })).rejects.toEqual(new Error('Code mode is closed, so this code did not run.'))
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** The default pool can fail before checkout, including both synchronous and asynchronous factory failures. */
  test.each(['throw', 'reject'] as const)('surfaces a pool factory %s without a model retry', async (failure) => {
    vi.stubEnv('LOGFIRE_API_KEY', 'synthetic-key')
    const error = new Error('Sandbox pool configuration is invalid')
    if (failure === 'throw') {
      vi.mocked(agentSandboxes).mockImplementationOnce(() => {
        throw error
      })
    } else {
      vi.mocked(agentSandboxes).mockRejectedValueOnce(error)
    }
    const onError = vi.fn<StreamTextOnErrorCallback>()
    await using code = codeMode({ tools: {}, onError })
    const model = callingModel()
    await expect(generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })).rejects.toBe(error)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(onError.mock.calls).toEqual([[{ error }]])
  })

  /** Missing credentials already fail at construction, before the model can run. */
  test('rejects a missing API key before pool creation', () => {
    vi.stubEnv('LOGFIRE_API_KEY', '')
    expect(() => codeMode({ tools: {} })).toThrow(
      'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
        'Set the LOGFIRE_API_KEY environment variable, or pass `sandboxes` to codeMode().'
    )
  })
})

describe('capacity checkout retry', () => {
  /** A pending capacity retry must keep a one-shot Node.js process alive even if the supplied pool has no active handles. */
  test('keeps the retry timer referenced', async () => {
    const error = new MontyRefusedError('Sandbox busy', { cause: 'capacity' })
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const before = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
    const failed = runCode(code, { code: '1' }).catch((failure: unknown) => failure)
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    const during = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
    expect(during).toBe(before + 1)
    expect(await failed).toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
  })

  /** Only the three known temporary refusal causes get a single delayed retry; no code has run yet. */
  test.each(['caller_cap', 'capacity', 'worker_unavailable'])('retries %s after 100 ms', async (cause) => {
    vi.useFakeTimers()
    const error = new MontyRefusedError('Sandbox busy', { statusCode: 'RESOURCE_EXHAUSTED', cause })
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const failed = runCode(code, { code: '1' }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(99)
    expect(checkout).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await failed).toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(checkout.mock.calls[1]).toEqual(checkout.mock.calls[0])
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
  })

  /** A recovered refusal is hidden from the model and still checks the first snippet's types. */
  test('continues after a successful second checkout', async () => {
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValueOnce(new MontyRefusedError('Sandbox busy', { cause: 'capacity' }))
    checkout.mockImplementationOnce(async (options) => pool.checkout(options))
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    expect(await runCode(code, { code: '1 + 1' })).toBe(2)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(checkout.mock.calls[1]?.[0]?.typeCheck).toBe(true)
  })

  /** Credential refusals must not retry, even if a server attaches a conflicting capacity cause. */
  test.each(['UNAUTHENTICATED', 'PERMISSION_DENIED'])('never retries %s', async (statusCode) => {
    const error = new MontyRefusedError('Sandbox access denied', { statusCode, cause: 'capacity' })
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** A cancellation during backoff must not start another checkout. */
  test('does not retry after abort', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(new MontyRefusedError('Sandbox busy', { cause: 'capacity' }))
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const failed = runCode(code, { code: '1' }, { abortSignal: controller.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    controller.abort()
    expect(await failed).toEqual(new Error('The agent run was aborted, so this code did not run.'))
    await vi.advanceTimersByTimeAsync(100)
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** Closing during backoff must release the run without starting another checkout. */
  test('does not retry after close', async () => {
    vi.useFakeTimers()
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(new MontyRefusedError('Sandbox busy', { cause: 'capacity' }))
    const code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const failed = runCode(code, { code: '1' }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    await code.close()
    expect(await failed).toEqual(new Error('Code mode is closed, so this code did not run.'))
    await vi.advanceTimersByTimeAsync(100)
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** A refusal without a known temporary cause must surface immediately, even with RESOURCE_EXHAUSTED status. */
  test.each([undefined, 'unknown_policy'])('does not retry refusal cause %s', async (cause) => {
    const error = new MontyRefusedError('Sandbox refused', { statusCode: 'RESOURCE_EXHAUSTED', ...(cause === undefined ? {} : { cause }) })
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValue(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(1)
  })

  /** A failed retry must surface its own error and prevent an immediate model-driven retry. */
  test('ends generateText with the second checkout error', async () => {
    const first = new MontyRefusedError('Sandbox busy', { cause: 'capacity' })
    const second = new Error('Could not dial sandbox replacement')
    const checkout = vi.fn<Sandboxes['checkout']>().mockRejectedValueOnce(first).mockRejectedValueOnce(second)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const model = callingModel()
    await expect(generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })).rejects.toBe(second)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(model.doGenerateCalls).toHaveLength(1)
  })
})

const timeLimitMessage =
  'The code ran longer than its time limit and was stopped, so the session was reset. Re-run any imports, ' +
  'recreate any state you need, and make the code do less work per call.'
const sessionEndedMessage =
  'The sandbox session ended and its state is lost. Re-run any imports and recreate any state you need. ' +
  'Check any tool calls already started before continuing, and do not replay completed side effects.'
const sessionResetMessage =
  'The sandbox session was replaced. Variables, imports and definitions from earlier calls are gone. ' +
  'Recreate any state you need, but do not replay completed side effects.'

describe('feed failures', () => {
  /** A Python error remains a model tool error, so the model can revise its code on a later step. */
  test('lets the model recover from a syntax error', async () => {
    await using code = codeMode({ tools: {}, sandboxes: pool })
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [{ ...call, input: '{"code":"def ("}' }], finishReason, usage, warnings: [] },
        { content: [{ type: 'text', text: 'revised' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
      ],
    })
    const result = await generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })
    expect(result.text).toBe('revised')
    expect(result.steps[0]?.content.map((part) => part.type)).toEqual(['tool-call', 'tool-error'])
    expect(model.doGenerateCalls).toHaveLength(2)
  })

  /** Watchdog and turn timeouts need the same actionable limit guidance; session expiry must explain lost state. */
  test.each([
    [new MontyCrashedError('request timeout', { timedOut: true }), timeLimitMessage],
    [new MontyDisconnectError('stream closed', { cause: 'turn_timeout' }), timeLimitMessage],
    [new MontyDisconnectError('stream closed', { cause: 'session_timeout' }), sessionEndedMessage],
    [new MontyDisconnectError('stream closed', { cause: 'idle_timeout' }), sessionEndedMessage],
    [new MontyCrashedError('worker died'), 'The code crashed the sandbox worker and the session was reset. Revise the code and try again.'],
  ])('gives specific guidance for %s', async (error, message) => {
    const counted = new CountingSandboxes(pool)
    const onError = vi.fn<StreamTextOnErrorCallback>()
    await using code = codeMode({ tools: {}, sandboxes: counted, onError })
    await runCode(code, { code: 'kept = 1' })
    const session = firstSession(counted)
    const close = vi.spyOn(session, 'close')
    vi.spyOn(session, 'feedRun').mockRejectedValueOnce(error)
    expect(await runCodeError(code, { code: '1' })).toBe(message)
    expect(close).toHaveBeenCalledTimes(1)
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/Name `kept` used when not defined/u)
    expect(counted.sessions).toHaveLength(2)
    expect(onError).not.toHaveBeenCalled()
  })

  /** Unknown disconnects and protocol failures cannot be fixed by changing Python and must not reach the model. */
  test.each([new MontyDisconnectError('stream closed'), new ProtocolError('invalid frame'), new Error('transport failed')])(
    'ends the run for %s',
    async (error) => {
      const counted = new CountingSandboxes(pool)
      const onError = vi.fn<StreamTextOnErrorCallback>()
      await using code = codeMode({ tools: {}, sandboxes: counted, onError })
      await runCode(code, { code: '1' })
      const close = vi.spyOn(firstSession(counted), 'close')
      vi.spyOn(firstSession(counted), 'feedRun').mockRejectedValueOnce(error)
      const model = callingModel()
      await expect(generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })).rejects.toBe(error)
      expect(close).toHaveBeenCalledTimes(1)
      expect(model.doGenerateCalls).toHaveLength(1)
      expect(onError.mock.calls).toEqual([[{ error }]])
    }
  )

  /** Timeout guidance must preserve completed call information so the model does not repeat side effects. */
  test.each([
    [new MontyCrashedError('request timeout', { timedOut: true }), timeLimitMessage],
    [new MontyDisconnectError('stream closed', { cause: 'turn_timeout' }), timeLimitMessage],
    [new MontyDisconnectError('stream closed', { cause: 'session_timeout' }), sessionEndedMessage],
  ])('lists started calls for %s', async (error, message) => {
    const counted = new CountingSandboxes(pool)
    const perform = tool({ inputSchema: z.object({}), outputSchema: z.object({}), execute: () => ({}) })
    await using code = codeMode({ tools: { perform }, sandboxes: counted })
    await runCode(code, { code: '1' })
    const session = firstSession(counted)
    const feedRun = session.feedRun.bind(session)
    vi.spyOn(session, 'feedRun').mockImplementationOnce(async (source, options) => {
      await feedRun(source, options)
      throw error
    })
    expect(await runCodeError(code, { code: 'await perform()' })).toBe(
      `${message}\n\n1 nested tool calls started before execution stopped:\n- perform({}) returned {}\n` +
        'Account for all 1 before retrying; repeating a call repeats whatever it already did.'
    )
  })
})

describe('server shutdown', () => {
  /** Printing before a shutdown must not duplicate the final attempt's output, even if the first capture was truncated. */
  test.each(['step 1\n', 'x'.repeat(1000)])('discards the first attempt output %#', async (printed) => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted, limits: { outputBytes: 200 } })
    await runCode(code, { code: 'kept = 1' })
    vi.spyOn(firstSession(counted), 'feedRun').mockImplementationOnce(async (_source, options) => {
      const print = options?.printCallback
      if (typeof print !== 'function') {
        throw new Error('No print callback')
      }
      print('stdout', printed)
      await delay(1)
      throw new MontyShutdown('shutdown during sleep after printing')
    })
    expect(await runCode(code, { code: 'print("step 1")' })).toEqual({
      result: { output: 'step 1\n' },
      sessionReset: sessionResetMessage,
    })
    expect(counted.sessions).toHaveLength(2)
  })

  /** Both conversion-budget and exact JSON-size failures on replay must explain that earlier snippets' state is lost. */
  test.each(['"x" * 1000', '"x" * 199'])('explains lost state for oversized replay result %s', async (source) => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted, limits: { outputBytes: 200 } })
    await runCode(code, { code: 'kept = 1' })
    vi.spyOn(firstSession(counted), 'feedRun').mockRejectedValueOnce(new MontyShutdown('server restarting'))
    expect(await runCodeError(code, { code: source })).toBe(
      'The result is more than 200 bytes of JSON, over the limit for what one snippet returns. ' +
        'The code ran and its variables are still defined, so return a smaller value from them, such as a summary or fewer fields.' +
        `\n\n${sessionResetMessage}`
    )
    expect(counted.sessions).toHaveLength(2)
  })

  /** A shutdown before the snippet runs is safe to replay once, on a fresh type-checked session. */
  test('replays once on a fresh session', async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted })
    await runCode(code, { code: 'kept = 1' })
    const first = firstSession(counted)
    const feed = vi.spyOn(first, 'feedRun').mockRejectedValueOnce(new MontyShutdown('server restarting'))
    const close = vi.spyOn(first, 'close')
    expect(await runCode(code, { code: '2 + 2' })).toEqual({ result: 4, sessionReset: sessionResetMessage })
    expect(feed).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(counted.sessions).toHaveLength(2)
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/NameError: name 'kept' is not defined/u)
  })

  /** A replay must restore first-snippet type checking and explain why previous variables are unavailable. */
  test('explains lost state when the replay needs an earlier variable', async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted })
    await runCode(code, { code: 'kept = 1' })
    vi.spyOn(firstSession(counted), 'feedRun').mockRejectedValueOnce(new MontyShutdown('server restarting'))
    const message = await runCodeError(code, { code: 'kept' })
    expect(message).toMatch(/^Type error in code:/u)
    expect(message.endsWith(`\n\n${sessionResetMessage}`)).toBe(true)
    expect(counted.sessions).toHaveLength(2)
  })

  /** Replaying a shutdown must not restart the wall-clock budget and permit a snippet to run longer. */
  test('keeps the original deadline when replaying', async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted, limits: { timeout: 100 } })
    await runCode(code, { code: '1' })
    const first = firstSession(counted)
    await first.close()
    vi.spyOn(first, 'close').mockResolvedValue()
    const replacement = await pool.checkout()
    vi.useFakeTimers()
    vi.spyOn(first, 'feedRun').mockImplementationOnce(async () => {
      await delay(60)
      throw new MontyShutdown('server restarting')
    })
    vi.spyOn(counted, 'checkout').mockResolvedValueOnce(replacement)
    const replay = vi.spyOn(replacement, 'feedRun').mockImplementationOnce(async () => {
      await delay(60)
      return 2
    })
    const failed = runCode(code, { code: '1' }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await failed).toEqual(
      new Error(
        'The code ran longer than its 0.1-second time limit, counting time spent waiting on tools, ' +
          'and was stopped, so the session was reset. Re-run any imports, recreate any state you need, and make the code do less work per call.'
      )
    )
    expect(replay).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
  })

  /** A deadline during replacement checkout must remain a time-limit error and must not execute more code. */
  test('does not feed a replacement checked out after the deadline', async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted, limits: { timeout: 100 } })
    await runCode(code, { code: '1' })
    const first = firstSession(counted)
    await first.close()
    vi.spyOn(first, 'close').mockResolvedValue()
    const replacement = await pool.checkout()
    const feed = vi.spyOn(replacement, 'feedRun')
    const close = vi.spyOn(replacement, 'close')
    vi.useFakeTimers()
    vi.spyOn(first, 'feedRun').mockRejectedValueOnce(new MontyShutdown('server restarting'))
    vi.spyOn(counted, 'checkout').mockImplementationOnce(async () => {
      await delay(150)
      return replacement
    })
    const failed = runCode(code, { code: '1' }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(150)
    expect(await failed).toEqual(
      new Error(
        'The code ran longer than its 0.1-second time limit, counting time spent waiting on tools, ' +
          'and was stopped, so the session was reset. Re-run any imports, recreate any state you need, and make the code do less work per call.'
      )
    )
    expect(feed).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  /** A persistent drain must end the run, not cause an unbounded replay loop or model retries. */
  test('surfaces the second shutdown', async () => {
    const error = new MontyShutdown('server still restarting')
    const checkout = vi.fn<Sandboxes['checkout']>(async (options) => {
      const session = await pool.checkout(options)
      vi.spyOn(session, 'feedRun').mockRejectedValue(error)
      return session
    })
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    const model = callingModel()
    await expect(generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(3) })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  /** Failure to open the replacement session is still a developer error, not a Python failure. */
  test('surfaces a replacement checkout error', async () => {
    const session = await pool.checkout()
    vi.spyOn(session, 'feedRun').mockRejectedValue(new MontyShutdown('server restarting'))
    const error = new Error('could not dial replacement')
    const checkout = vi.fn<Sandboxes['checkout']>().mockResolvedValueOnce(session).mockRejectedValueOnce(error)
    await using code = codeMode({ tools: {}, sandboxes: { checkout, close: async () => Promise.resolve() } })
    await expect(runCode(code, { code: '1' })).rejects.toBe(error)
    expect(checkout).toHaveBeenCalledTimes(2)
  })

  /** Shutdown can reject a resume after a host callback, so blindly replaying feedRun would duplicate side effects. */
  test.each(['raw', 'wrapped'])('does not replay a snippet after a tool has started on %s shutdown', async (kind) => {
    const counted = new CountingSandboxes(pool)
    const action = vi.fn<() => object>(() => ({}))
    const perform = tool({ inputSchema: z.object({}), outputSchema: z.object({}), execute: action })
    await using code = codeMode({ tools: { perform }, sandboxes: counted })
    await runCode(code, { code: '1' })
    const session = firstSession(counted)
    const feedRun = session.feedRun.bind(session)
    const shutdown = new MontyShutdown('Agent Sandboxes shutdown while answering a callback')
    const error = kind === 'raw' ? shutdown : new Error('Agent Sandboxes request failed', { cause: shutdown })
    vi.spyOn(session, 'feedRun').mockImplementationOnce(async (source, options) => {
      await feedRun(source, options)
      throw error
    })
    await expect(runCode(code, { code: 'await perform()' })).rejects.toBe(error)
    expect(action).toHaveBeenCalledTimes(1)
    expect(counted.sessions).toHaveLength(1)
  })

  /** A callback waiting for approval has already reserved a call, and must be cancelled rather than duplicated by shutdown replay. */
  test('does not replay or execute a tool waiting for approval', async () => {
    let approve: (status: 'approved') => void = () => undefined
    const approval = new Promise<'approved'>((resolve) => {
      approve = resolve
    })
    let requested: () => void = () => undefined
    const approvalRequested = new Promise<void>((resolve) => {
      requested = resolve
    })
    const counted = new CountingSandboxes(pool)
    const action = vi.fn<() => object>(() => ({}))
    const perform = tool({ inputSchema: z.object({}), outputSchema: z.object({}), execute: action })
    await using code = codeMode({
      tools: { perform },
      sandboxes: counted,
      approval: async () => {
        requested()
        return await approval
      },
    })
    await runCode(code, { code: '1' })
    const error = new MontyShutdown('shutdown while waiting for approval')
    let pending: Promise<unknown> = Promise.resolve()
    const session = firstSession(counted)
    const close = session.close.bind(session)
    vi.spyOn(session, 'close').mockImplementationOnce(async () => {
      await delay(50)
      await close()
    })
    vi.spyOn(session, 'feedRun').mockImplementationOnce(async (_source, options) => {
      const callback = options?.externalLookup?.['perform']
      if (typeof callback !== 'function') {
        throw new Error('No host callback for perform')
      }
      pending = (callback as () => Promise<unknown>)().catch((error: unknown) => error)
      await approvalRequested
      throw error
    })
    const failed = runCode(code, { code: 'await perform()' }).catch((error: unknown) => error)
    await approvalRequested
    await delay(20)
    approve('approved')
    expect(await failed).toBe(error)
    await pending
    expect(action).not.toHaveBeenCalled()
    expect(counted.sessions).toHaveLength(1)
  })
})
