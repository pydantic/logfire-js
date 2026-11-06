import type { ToolExecutionOptions } from 'ai'

import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { context, trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Monty, MontyRuntimeError } from '@pydantic/monty'
import { generateText, stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import * as logfire from 'logfire'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { Sandboxes } from './codeMode'

import { codeMode } from './codeMode'
import { CountingSandboxes, delay, runCode, runCodeError } from './testing'

let pool: Monty
const spans = new InMemorySpanExporter()

beforeAll(async () => {
  pool = await Monty.create({ maxProcesses: 4 })
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }))
})

afterAll(async () => {
  await pool.close()
})

beforeEach(() => {
  spans.reset()
})

const add = tool({
  description: 'Add two numbers.',
  inputSchema: z.object({ a: z.number(), b: z.number().default(0) }),
  outputSchema: z.object({ sum: z.number() }),
  execute: ({ a, b }) => ({ sum: a + b }),
})

const fail = tool({
  description: 'Always fails.',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  execute: () => {
    throw new Error('the tool broke')
  },
})

function sandboxes(): CountingSandboxes {
  return new CountingSandboxes(pool)
}

describe('an agent run', () => {
  test('uses one session for every run_code call, in the order the model made them', async () => {
    const counted = sandboxes()
    const code = codeMode({ tools: { add }, sandboxes: counted })
    const call = (toolCallId: string, source: string) => ({
      type: 'tool-call' as const,
      toolCallId,
      toolName: 'run_code',
      input: JSON.stringify({ code: source }),
    })
    const finish = (unified: 'stop' | 'tool-calls') => ({
      finishReason: { unified, raw: unified },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    })
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [call('first', 'x = (await add(a=1, b=2))["sum"]\nx')], ...finish('tool-calls') },
        { content: [call('second', 'y = x * 10\ny'), call('third', 'x + y')], ...finish('tool-calls') },
        { content: [{ type: 'text', text: 'done' }], ...finish('stop') },
      ],
    })

    const { text, steps } = await generateText({ model, prompt: 'go', tools: code.tools, stopWhen: stepCountIs(5) })

    expect(text).toBe('done')
    expect(steps.flatMap((step) => step.toolResults.map((result) => [result.toolCallId, result.output]))).toEqual([
      ['first', 3],
      ['second', 30],
      ['third', 33],
    ])
    expect(counted.sessions).toHaveLength(1)
    await code.close()
    await code.close()
    expect(counted.closed).toBe(false)
    expect(await runCode(codeMode({ tools: {}, sandboxes: counted }), { code: '1 + 1' })).toBe(2)
  })

  test('checks out nothing when the model never runs code', async () => {
    const counted = sandboxes()
    const code = codeMode({ tools: { add }, sandboxes: counted })
    await code.close()
    expect(counted.checkouts).toEqual([])
  })

  test('checks sessions out as ephemeral and type-checked, with the tool stubs', async () => {
    const counted = sandboxes()
    await using code = codeMode({ tools: { add }, sandboxes: counted })
    await runCode(code, { code: '1' })
    expect(counted.checkouts[0]).toMatchObject({ ephemeral: true, scriptName: 'run_code.py', typeCheck: true })
    expect(counted.checkouts[0]?.typeCheckStubs).toContain('async def add(*, a: float, b: float = 0) -> AddReturn:')
  })
})

describe('nested calls', () => {
  test('receive plain, validated input and the AI SDK execution options', async () => {
    const seen: { input: unknown; options: ToolExecutionOptions<unknown> }[] = []
    const inspect = tool({
      inputSchema: z.object({ nested: z.object({ items: z.array(z.object({ id: z.number() })) }), flag: z.boolean().default(true) }),
      outputSchema: z.object({ ok: z.boolean() }),
      contextSchema: z.object({ tenant: z.string() }),
      execute: (input, options) => {
        seen.push({ input, options })
        return { ok: true }
      },
    })
    const messages = [{ role: 'user' as const, content: 'hi' }]
    const controller = new AbortController()
    await using code = codeMode({ tools: { inspect }, sandboxes: sandboxes(), context: { inspect: { tenant: 'acme' } } })
    await runCode(
      code,
      { code: 'await inspect(nested={"items": [{"id": 1}]})\nawait inspect(nested={"items": []}, flag=False)' },
      { toolCallId: 'parent', messages, abortSignal: controller.signal }
    )
    expect(seen.map(({ input }) => input)).toEqual([
      { nested: { items: [{ id: 1 }] }, flag: true },
      { nested: { items: [] }, flag: false },
    ])
    expect(seen.map(({ options }) => options.toolCallId)).toEqual(['parent__1', 'parent__2'])
    expect(seen[0]?.options.messages).toBe(messages)
    expect(seen[0]?.options.context).toEqual({ tenant: 'acme' })
    expect(seen[0]?.options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  test.each(['first-snippet', 'off'] as const)(
    'restore schema property names that are not Python names, with type checking %s',
    async (typeCheck) => {
      const seen: unknown[] = []
      const approved: unknown[] = []
      const search = tool({
        inputSchema: z.object({ from: z.string(), 'user-id': z.string(), filter: z.object({ '@type': z.string() }) }),
        outputSchema: z.object({ ok: z.boolean() }),
        execute: (input) => {
          seen.push(input)
          return { ok: true }
        },
      })
      await using code = codeMode({
        tools: { search },
        sandboxes: sandboxes(),
        typeCheck,
        approval: ({ toolCall }) => {
          approved.push(toolCall.input)
          return 'approved'
        },
      })
      const result = await runCode(code, { code: `(await search(from_="ana", user_id="u1", filter={'@type': 'mail'}))["ok"]` })
      const input = { from: 'ana', 'user-id': 'u1', filter: { '@type': 'mail' } }
      expect(result).toBe(true)
      expect(seen).toEqual([input])
      expect(approved).toEqual([input])
    }
  )

  test('raise in the sandbox for bad input, bad context, positional arguments and tool errors', async () => {
    const needsContext = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      contextSchema: z.object({ tenant: z.string() }),
      execute: () => ({}),
    })
    await using code = codeMode({ tools: { add, fail, needsContext }, sandboxes: sandboxes(), typeCheck: 'off' })
    const caught = async (call: string): Promise<unknown> =>
      runCode(code, {
        code: `try:\n    await ${call}\n    r = "no error"\nexcept Exception as e:\n    r = type(e).__name__ + ": " + str(e)\nr`,
      })
    expect(await caught('add(a="x")')).toMatch(/^ValueError: Invalid arguments for add\(\): /u)
    expect(await caught('add(1, 2)')).toBe('TypeError: add() does not accept positional arguments; use keyword arguments')
    expect(await caught('fail()')).toBe('RuntimeError: the tool broke')
    expect(await caught('needsContext()')).toMatch(/^ValueError: Invalid context for tool "needsContext": /u)
    expect(await runCode(code, { code: '(await add(a=2))["sum"]' })).toBe(2)
  })

  test('take the last value of a streaming tool', async () => {
    const stream = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({ step: z.number() }),
      async *execute() {
        await Promise.resolve()
        yield { step: 1 }
        yield { step: 2 }
      },
    })
    await using code = codeMode({ tools: { stream }, sandboxes: sandboxes() })
    expect(await runCode(code, { code: '(await stream())["step"]' })).toBe(2)
  })

  test('each get a span under the span that is active when run_code runs', async () => {
    await using code = codeMode({ tools: { add, fail }, sandboxes: sandboxes(), typeCheck: 'off' })
    await logfire.span('parent', {}, {}, async () =>
      runCode(code, { code: 'await add(a=1)\ntry:\n    await fail()\nexcept Exception:\n    pass' })
    )
    const finished = spans.getFinishedSpans()
    const parent = finished.find((span) => span.name === 'parent')
    const nested = finished.filter((span) => span.name === 'run_code called {tool_name}')
    expect(nested.map((span) => [span.attributes['tool_name'], span.parentSpanContext?.spanId, span.status.code])).toEqual([
      ['add', parent?.spanContext().spanId, 0],
      ['fail', parent?.spanContext().spanId, 2],
    ])
  })
})

describe('results', () => {
  test('use pydantic-ai shapes', async () => {
    await using code = codeMode({ tools: {}, sandboxes: sandboxes() })
    expect(await runCode(code, { code: '{"a": {"b": [1, 2]}}' })).toEqual({ a: { b: [1, 2] } })
    expect(await runCode(code, { code: 'None' })).toEqual({})
    expect(await runCode(code, { code: 'z = 1' })).toEqual({})
    expect(await runCode(code, { code: 'print("hi")' })).toEqual({ output: 'hi\n' })
    expect(await runCode(code, { code: 'print("hi")\nz' })).toEqual({ output: 'hi\n', result: 1 })
    expect(await runCode(code, { code: '[float("inf"), float("nan"), {1, 2}, 2**70]' })).toEqual([
      'inf',
      'nan',
      [1, 2],
      '1180591620717411303424',
    ])
  })
})

describe('failures', () => {
  test("use pydantic-ai's messages and keep the session after code errors", async () => {
    const counted = sandboxes()
    await using code = codeMode({ tools: { add }, sandboxes: counted })
    await runCode(code, { code: 'kept = 1' })
    expect(await runCodeError(code, { code: 'def (' })).toMatch(/^Syntax error in code:\nTraceback[\s\S]*SyntaxError/u)
    expect(await runCodeError(code, { code: 'await add(a="one")' })).toMatch(/^Runtime error:\n/u)
    expect(await runCodeError(code, { code: 'print("x")\n1 / 0' })).toMatch(
      /^Runtime error:\n\[stdout before error\]\nx\n\[\/stdout before error\]\nTraceback[\s\S]*ZeroDivisionError/u
    )
    expect(await runCode(code, { code: 'kept' })).toBe(1)
    expect(counted.sessions).toHaveLength(1)
  })

  test('type-check the first snippet only, by default', async () => {
    await using code = codeMode({ tools: { add }, sandboxes: sandboxes() })
    expect(await runCodeError(code, { code: 'await add(a="one")' })).toMatch(/^Type error in code:\n/u)
    await runCode(code, { code: 'await add(a=1)' })
    // Later snippets are not checked, so this fails only when it runs.
    expect(await runCodeError(code, { code: 'await add(a="one")' })).toMatch(/^Runtime error:\n/u)
  })

  test('type-check every snippet when asked', async () => {
    await using code = codeMode({ tools: { add }, sandboxes: sandboxes(), typeCheck: 'every-snippet' })
    await runCode(code, { code: 'await add(a=1)' })
    expect(await runCodeError(code, { code: 'await add(a="one")' })).toMatch(/^Type error in code:\n/u)
  })

  test('replace the session when the worker crashes', async () => {
    const counted = sandboxes()
    const crash = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        const pid = counted.sessions.at(-1)?.workerPid
        process.kill(pid ?? 0, 'SIGKILL')
        await delay(100)
        return {}
      },
    })
    await using code = codeMode({ tools: { crash }, sandboxes: counted })
    await runCode(code, { code: 'kept = 1' })
    const message = await runCodeError(code, { code: 'await crash()' }, { toolCallId: 'boom' })
    expect(message).toMatch(/^The code crashed the sandbox worker and the session was reset\. Revise the code and try again\./u)
    expect(message).toContain('1 nested tool calls started before execution stopped:\n- crash({})')
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/Name `kept` used when not defined/u)
    expect(counted.sessions).toHaveLength(2)
  })

  test('restart: true starts a fresh, type-checked session', async () => {
    const counted = sandboxes()
    await using code = codeMode({ tools: { add }, sandboxes: counted })
    await runCode(code, { code: 'kept = (await add(a=1))["sum"]' })
    expect(await runCodeError(code, { code: 'await add(a="one")', restart: true })).toMatch(/^Type error in code:\n/u)
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/Name `kept` used when not defined/u)
    expect(counted.sessions).toHaveLength(2)
  })
})

describe('lifecycle', () => {
  test('closeWhenDone closes once the stream settles, also when it errors or is aborted', async () => {
    const settled = [async () => Promise.resolve('stop'), async () => Promise.reject(new Error('stream failed'))]
    await Promise.all(
      settled.map(async (settle) => {
        const code = codeMode({ tools: {}, sandboxes: sandboxes() })
        await runCode(code, { code: '1' })
        await code.closeWhenDone({ finishReason: settle() })
        expect(await runCodeError(code, { code: '1' })).toBe('Code mode is closed, so this code did not run.')
      })
    )

    const controller = new AbortController()
    const code = codeMode({ tools: {}, sandboxes: sandboxes() })
    const model = new MockLanguageModelV4({
      doStream: () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    })
    const result = streamText({ model, prompt: 'go', tools: code.tools, abortSignal: controller.signal })
    await code.closeWhenDone(result)
    expect(await runCodeError(code, { code: '1' })).toBe('Code mode is closed, so this code did not run.')
  })

  test('close() rejects queued calls and waits for the running one', async () => {
    let release: () => void = () => undefined
    let started = false
    const wait = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        started = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return {}
      },
    })
    const counted = sandboxes()
    const code = codeMode({ tools: { wait }, sandboxes: counted })
    const running = runCodeError(code, { code: 'await wait()' })
    const queued = runCodeError(code, { code: '1' })
    // Close only once the tool runs, so the snippet has a started call to report.
    await vi.waitFor(() => {
      expect(started).toBe(true)
    })
    const closed = code.close()
    release()
    await closed
    expect(await running).toMatch(
      /^Code mode was closed while this code ran, so tool calls it had not started were stopped\.\n\n1 nested tool calls started/u
    )
    expect(await queued).toBe('Code mode is closed, so this code did not run.')
  })

  test('a slow checkout does not count against the time limit', async () => {
    const slow: Sandboxes = {
      checkout: async (options) => {
        await delay(1500)
        return pool.checkout(options)
      },
      close: async () => Promise.resolve(),
    }
    await using code = codeMode({ tools: {}, sandboxes: slow, limits: { timeout: 1 } })
    expect(await runCode(code, { code: '1 + 1' })).toBe(2)
  })

  test('a failed checkout leaves the next session type-checked', async () => {
    let refuse = true
    const flaky: Sandboxes = {
      checkout: async (options) => {
        if (refuse) {
          refuse = false
          throw new MontyRuntimeError('RuntimeError', 'server refused the session')
        }
        return pool.checkout(options)
      },
      close: async () => Promise.resolve(),
    }
    await using code = codeMode({ tools: { add }, sandboxes: flaky })
    // As in pydantic-ai, where the checkout sits inside the feed's `except MontyRuntimeError`.
    expect(await runCodeError(code, { code: '1' })).toBe('Runtime error:\nRuntimeError: server refused the session')
    expect(await runCodeError(code, { code: 'await add(a="one")' })).toMatch(/^Type error in code:\n/u)
  })

  test('an oversized snippet keeps the idle timeout running', async () => {
    const counted = sandboxes()
    await using code = codeMode({ tools: {}, sandboxes: counted, idleTimeout: 0.2, limits: { codeBytes: 50 } })
    await runCode(code, { code: 'kept = 1' })
    await runCodeError(code, { code: `# ${'x'.repeat(100)}` })
    await delay(400)
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/had no run_code call for 0\.2 seconds/u)
  })

  test('the idle timeout releases the session and the next call says so if it fails', async () => {
    const counted = sandboxes()
    await using code = codeMode({ tools: {}, sandboxes: counted, idleTimeout: 0.2 })
    await runCode(code, { code: 'kept = 1' })
    await delay(400)
    expect(await runCodeError(code, { code: 'kept' })).toMatch(
      /^Type error in code:[\s\S]*Name `kept` used when not defined[\s\S]*\n\nThe sandbox session had no run_code call for 0\.2 seconds and was replaced, so variables, imports and definitions from earlier calls are gone\.$/u
    )
    expect(counted.sessions).toHaveLength(2)
    expect(await runCode(code, { code: 'kept = 2\nkept' })).toBe(2)
  })
})

describe('setup', () => {
  test('rejects tools code mode cannot run', () => {
    const noExecute = tool({ inputSchema: z.object({}), outputSchema: z.object({}) })
    expect(() => codeMode({ tools: { noExecute }, sandboxes: sandboxes() })).toThrow(/Tool "noExecute" has no execute function/u)
    const projected = tool({ ...add, toModelOutput: () => ({ type: 'text', value: 'hidden' }) })
    expect(() => codeMode({ tools: { projected }, sandboxes: sandboxes() })).toThrow(
      /Tool "projected" sets toModelOutput, which code mode cannot apply/u
    )
    const gated = { ...add, needsApproval: true }
    expect(() => codeMode({ tools: { gated }, sandboxes: sandboxes() })).toThrow(/Tool "gated" sets needsApproval/u)
    expect(() => codeMode({ tools: { run_code: add }, sandboxes: sandboxes() })).toThrow(/reserves for itself/u)
    expect(() => codeMode({ tools: { open: add }, sandboxes: sandboxes() })).toThrow(
      'Tool "open" becomes the Python function "open", which is a Python builtin, so sandbox code would call the builtin instead. Rename the tool.'
    )
  })

  test('needs an API key when it creates the sandboxes itself', () => {
    vi.stubEnv('LOGFIRE_API_KEY', '')
    expect(() => codeMode({ tools: {} })).toThrow(/Set the LOGFIRE_API_KEY environment variable, or pass `sandboxes`/u)
    vi.unstubAllEnvs()
  })
})
