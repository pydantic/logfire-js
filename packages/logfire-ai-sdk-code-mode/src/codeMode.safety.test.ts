import type { ToolApprovalConfiguration } from 'ai'
import type { WebSocket as RelaySocket } from 'ws'

import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { context, trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Monty, MontyWebsocket } from '@pydantic/monty'
import { findMontyBinary } from '@pydantic/monty/node'
import { tool } from 'ai'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { z } from 'zod'

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

function countingTool(calls: unknown[] = []) {
  return tool({
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ n: z.number() }),
    execute: async ({ n }) => {
      calls.push(n)
      await delay(5)
      return { n }
    },
  })
}

// Catches the error in the sandbox and returns its type and message, or the value when there is none.
function caught(call: string): string {
  return `try:\n    r = await ${call}\nexcept Exception as e:\n    r = type(e).__name__ + ": " + str(e)\nr`
}

describe('approval', () => {
  test('a per-tool map applies to every nested call, also gathered ones', async () => {
    const calls: unknown[] = []
    const tools = { allowed: countingTool(calls), closed: countingTool(calls), person: countingTool(calls), checked: countingTool(calls) }
    const approval: ToolApprovalConfiguration<typeof tools, unknown> = {
      closed: { type: 'denied', reason: 'Closed for maintenance.' },
      person: 'user-approval',
      checked: (input) => (input.n > 1 ? 'denied' : 'approved'),
    }
    await using code = codeMode({ tools, sandboxes: pool, approval, typeCheck: 'off' })
    expect(await runCode(code, { code: caught('closed(n=1)') })).toBe("RuntimeError: Tool 'closed' call denied: Closed for maintenance.")
    expect(await runCode(code, { code: caught('person(n=1)') })).toBe(
      "RuntimeError: Tool 'person' needs a person to approve it, and code mode cannot ask for approval from inside the sandbox."
    )
    expect(await runCode(code, { code: caught('checked(n=2)') })).toBe(
      "RuntimeError: Tool 'checked' call denied: denied by the approval policy"
    )
    const gathered = await runCode(code, {
      code: 'import asyncio\nr = await asyncio.gather(allowed(n=1), checked(n=1))\n[x["n"] for x in r]',
    })
    expect(gathered).toEqual([1, 1])
    expect(calls).toEqual([1, 1])
  })

  test('a generic function gets the call, the tools, the context and runtimeContext', async () => {
    const seen: unknown[] = []
    const tools = { lookup: countingTool() }
    await using code = codeMode({
      tools,
      sandboxes: pool,
      context: { lookup: { tenant: 'acme' } },
      runtimeContext: { user: 'ada' },
      approval: ({ toolCall, tools: given, toolsContext, runtimeContext, messages }) => {
        seen.push({ toolCall, given: Object.keys(given ?? {}), toolsContext, runtimeContext, messages })
        return { type: 'denied', reason: 'Not today.' }
      },
    })
    expect(await runCode(code, { code: caught('lookup(n=3)') }, { toolCallId: 'p' })).toBe(
      "RuntimeError: Tool 'lookup' call denied: Not today."
    )
    expect(seen).toEqual([
      {
        toolCall: { type: 'tool-call', toolCallId: 'p__1', toolName: 'lookup', input: { n: 3 } },
        given: ['lookup'],
        toolsContext: { lookup: { tenant: 'acme' } },
        runtimeContext: { user: 'ada' },
        messages: [],
      },
    ])
  })
})

describe('approval that takes time', () => {
  test('is bounded by the deadline, and a call approved too late never runs', async () => {
    const calls: unknown[] = []
    await using code = codeMode({
      tools: { slow: countingTool(calls) },
      sandboxes: pool,
      limits: { timeout: 0.3 },
      approval: {
        slow: async () => {
          await delay(800)
          return 'approved' as const
        },
      },
    })
    const started = Date.now()
    expect(await runCodeError(code, { code: 'await slow(n=1)' })).toMatch(/time limit/u)
    expect(Date.now() - started).toBeLessThan(700)
    await delay(700)
    expect(calls).toEqual([])
  })

  test('a call still waiting when its sibling fails never runs', async () => {
    const calls: unknown[] = []
    const broken = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: () => {
        throw new Error('broken')
      },
    })
    await using code = codeMode({
      tools: { broken, slow: countingTool(calls) },
      sandboxes: pool,
      approval: {
        slow: async () => {
          await delay(300)
          return 'approved' as const
        },
      },
    })
    expect(await runCodeError(code, { code: 'import asyncio\nawait asyncio.gather(broken(), slow(n=1))' })).toMatch(/broken/u)
    await delay(500)
    expect(calls).toEqual([])
  })

  test('a map without an entry for a tool named like an Object method approves it', async () => {
    const calls: unknown[] = []
    const tools = { toString: countingTool(calls), other: countingTool() }
    await using code = codeMode({
      tools,
      sandboxes: pool,
      approval: { other: 'denied' } as ToolApprovalConfiguration<typeof tools, unknown>,
      context: {},
    })
    expect(await runCode(code, { code: '(await toString(n=4))["n"]' })).toBe(4)
    expect(calls).toEqual([4])
  })
})

describe('the call budget', () => {
  const BUDGET_MESSAGE =
    'RuntimeError: Code mode allows 2 nested tool calls per `run_code` call and this snippet asked for more. Call fewer tools, for example by filtering the inputs first, or split the work across several `run_code` calls.'

  test('stops the third call in sequence before it reaches the tool', async () => {
    const calls: unknown[] = []
    await using code = codeMode({ tools: { count: countingTool(calls) }, sandboxes: pool, limits: { toolCalls: 2 } })
    const message = await runCodeError(code, { code: 'for i in range(3):\n    await count(n=i)' })
    expect(calls).toEqual([0, 1])
    expect(message).toContain(BUDGET_MESSAGE)
    expect(message).toContain(
      "2 nested tool calls started before execution stopped:\n- count({'n': 0}) returned {'n': 0}\n- count({'n': 1}) returned {'n': 1}\nAccount for all 2 before retrying"
    )
  })

  test('stops the third call through one gather before it reaches the tool', async () => {
    // The first two calls wait until the snippet ends, so the third is always refused while they still run.
    const calls: unknown[] = []
    const hold = tool({
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      execute: async ({ n }, { abortSignal }) => {
        calls.push(n)
        await new Promise((resolve) => {
          abortSignal?.addEventListener('abort', resolve)
        })
        return { n }
      },
    })
    await using code = codeMode({ tools: { hold }, sandboxes: pool, limits: { toolCalls: 2 } })
    const message = await runCodeError(code, { code: 'import asyncio\nawait asyncio.gather(hold(n=0), hold(n=1), hold(n=2))' })
    expect(calls).toEqual([0, 1])
    expect(message).toContain(BUDGET_MESSAGE)
    // Ending the snippet stops the two calls that were still running.
    expect(message).toContain(
      "2 nested tool calls started before execution stopped:\n- hold({'n': 0}) did not finish, so it may have applied a partial change\n- hold({'n': 1}) did not finish, so it may have applied a partial change\nAccount for all 2 before retrying"
    )
  })
})

describe('the wall-clock deadline', () => {
  test('stops a host call that never settles, and later calls never start', async () => {
    let aborted = false
    const afterwards: unknown[] = []
    const stuck = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async (_, { abortSignal }) => {
        abortSignal?.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<never>(() => {
          // Never settles, and ignores the abort signal.
        })
      },
    })
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: { stuck, after: countingTool(afterwards) }, sandboxes: counted, limits: { timeout: 1 } })
    await runCode(code, { code: 'kept = 1' })
    const started = Date.now()
    const message = await runCodeError(code, { code: 'try:\n    await stuck()\nexcept Exception:\n    pass\nawait after(n=1)' })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(aborted).toBe(true)
    expect(afterwards).toEqual([])
    expect(message).toContain(
      'The code ran longer than its 1-second time limit, counting time spent waiting on tools, and was stopped, so the session was reset.'
    )
    expect(message).toContain('- stuck({}) did not finish, so it may have applied a partial change')
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/Name `kept` used when not defined/u)
    expect(counted.sessions).toHaveLength(2)
  })

  test('also bounds sleeps and pure computation', async () => {
    await using code = codeMode({ tools: {}, sandboxes: pool, limits: { timeout: 1 } })
    expect(
      await runCode(code, { code: 'import time\ntry:\n    time.sleep(5)\n    r = "slept"\nexcept TimeoutError as e:\n    r = str(e)\nr' })
    ).toMatch(/^sleeping 5s would exceed the 1s this code may run; [01]\.\ds left$/u)
    const started = Date.now()
    expect(await runCodeError(code, { code: 'while True:\n    pass' })).toMatch(/time limit/u)
    expect(Date.now() - started).toBeLessThan(2500)
    expect(await runCode(code, { code: 'import asyncio\nawait asyncio.gather(asyncio.sleep(0.2), asyncio.sleep(0.2))\n"ok"' })).toBe('ok')
  })
})

describe('size and concurrency caps', () => {
  test('reject or cut what is too large', async () => {
    const big = tool({
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => ({ text: text.repeat(100) }),
    })
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({
      tools: { big },
      sandboxes: counted,
      typeCheck: 'off',
      limits: { codeBytes: 200, outputBytes: 300, toolInputBytes: 50, toolOutputBytes: 500 },
    })
    await runCode(code, { code: 'kept = "x" * 1000' })
    expect(await runCodeError(code, { code: `# ${'x'.repeat(300)}` })).toBe(
      'The code is 302 bytes, over the 200-byte limit for one snippet. Send less code per call; variables and functions from earlier calls are still defined.'
    )
    expect(await runCodeError(code, { code: 'kept' })).toMatch(/^The result is more than 300 bytes of JSON, over the limit/u)
    expect(await runCode(code, { code: 'len(kept)' })).toBe(1000)
    expect(await runCode(code, { code: 'print("y" * 400)' })).toEqual({ output: `${'y'.repeat(300)}\n[printed output cut at 300 bytes]\n` })
    expect(await runCode(code, { code: caught('big(text="z" * 60)') })).toMatch(
      /^ValueError: The arguments to big\(\) are more than 50 bytes of JSON, over the limit for one call\.$/u
    )
    expect(await runCode(code, { code: caught('big(text="z" * 10)') })).toMatch(
      /^ValueError: big\(\) returned \d+ bytes of JSON, over the 500-byte limit for one call\. The call ran, so do not repeat it/u
    )
    expect(counted.sessions).toHaveLength(1)
  })

  test('stop converting a shared value before it expands on the host', async () => {
    const calls: unknown[] = []
    const take = tool({
      inputSchema: z.object({ value: z.unknown() }),
      outputSchema: z.object({}),
      execute: ({ value }) => {
        calls.push(value)
        return {}
      },
    })
    await using code = codeMode({ tools: { take }, sandboxes: pool, typeCheck: 'off' })
    // 40 sandbox lists that share their items stand for 2**40 leaves once copied.
    const shared = 'x = [1]\nfor i in range(40):\n    x = [x, x]'
    expect(await runCodeError(code, { code: `${shared}\nx` })).toMatch(/^The result is more than 64000 bytes of JSON/u)
    expect(await runCode(code, { code: caught('take(value=x)') })).toBe(
      'ValueError: The arguments to take() are more than 1000000 bytes of JSON, over the limit for one call.'
    )
    expect(calls).toEqual([])
  })

  test('keep a slot until a tool that ignores its abort signal settles, across run_code calls', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const stubborn = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await delay(600)
        inFlight -= 1
        return {}
      },
    })
    await using code = codeMode({ tools: { stubborn }, sandboxes: pool, limits: { timeout: 0.2, concurrentToolCalls: 1 } })
    await runCodeError(code, { code: 'await stubborn()' })
    await runCodeError(code, { code: 'await stubborn()' })
    await runCodeError(code, { code: 'await stubborn()' })
    await delay(700)
    expect(maxInFlight).toBe(1)
  })

  test('keep a __proto__ key as data', async () => {
    const seen: unknown[] = []
    const take = tool({
      inputSchema: z.object({ value: z.unknown() }),
      outputSchema: z.object({}),
      execute: ({ value }) => {
        seen.push(value)
        return {}
      },
    })
    await using code = codeMode({ tools: { take }, sandboxes: pool, typeCheck: 'off' })
    await runCode(code, { code: 'await take(value={"__proto__": {"admin": True}})' })
    const [value] = seen as Record<string, unknown>[]
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(value?.['admin']).toBeUndefined()
    expect(JSON.stringify(value)).toBe('{"__proto__":{"admin":true}}')
  })

  test('run at most concurrentToolCalls host calls at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const slow = tool({
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await delay(10)
        inFlight -= 1
        return { n }
      },
    })
    await using code = codeMode({ tools: { slow }, sandboxes: pool, limits: { concurrentToolCalls: 3 } })
    const result = await runCode(code, { code: 'import asyncio\nr = await asyncio.gather(*[slow(n=i) for i in range(20)])\nlen(r)' })
    expect(result).toBe(20)
    expect(maxInFlight).toBe(3)
  })
})

describe('onToolError', () => {
  test('replaces the message before the sandbox, the model or a span sees it', async () => {
    const leaky = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: () => {
        throw new Error('secret token xyz')
      },
    })
    const calls: unknown[] = []
    await using code = codeMode({
      tools: { leaky },
      sandboxes: pool,
      onToolError: (error, call) => {
        calls.push(call)
        return error instanceof Error && error.message.includes('secret') ? 'The tool failed.' : undefined
      },
    })
    expect(await runCode(code, { code: caught('leaky()') }, { toolCallId: 'q' })).toBe('RuntimeError: The tool failed.')
    expect(await runCodeError(code, { code: 'await leaky()' })).not.toContain('secret')
    expect(calls[0]).toEqual({ toolName: 'leaky', toolCallId: 'q__1', input: {} })
    const exported = JSON.stringify(
      spans.getFinishedSpans().map((span) => ({ attributes: span.attributes, events: span.events, status: span.status }))
    )
    expect(exported).toContain('The tool failed.')
    expect(exported).not.toContain('secret')
  })
})

describe('a lost connection', () => {
  test('replaces the session and lists the calls that started', async () => {
    const sockets: RelaySocket[] = []
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    // The same relay as examples/agent-sandboxes/smoke.ts: each connection gets its own `monty subprocess` worker.
    server.on('connection', (ws) => {
      sockets.push(ws)
      const worker = spawn(findMontyBinary(), ['subprocess'], { stdio: ['pipe', 'pipe', 'inherit'] })
      ws.on('message', (data: Buffer) => {
        const prefix = Buffer.alloc(4)
        prefix.writeUInt32LE(data.length)
        worker.stdin.write(Buffer.concat([prefix, data]))
      })
      let pending = Buffer.alloc(0)
      worker.stdout.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
          const size = pending.readUInt32LE(0)
          ws.send(pending.subarray(4, 4 + size))
          pending = pending.subarray(4 + size)
        }
      })
      ws.on('close', () => {
        worker.kill()
      })
      worker.on('exit', () => {
        ws.close()
      })
    })
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address !== 'object') {
      throw new Error('the relay has no port')
    }
    const remote = await MontyWebsocket.create(`ws://127.0.0.1:${String(address.port)}/`)
    const drop = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        sockets.at(-1)?.terminate()
        await delay(100)
        return { ok: true }
      },
    })
    try {
      await using code = codeMode({ tools: { drop, count: countingTool() }, sandboxes: remote })
      await runCode(code, { code: 'kept = (await count(n=1))["n"]' })
      const message = await runCodeError(code, { code: 'await count(n=2)\nawait drop()' })
      expect(message).toMatch(
        /^Code execution failed and the session was reset\. Re-run any imports, recreate any state you need, and try again\.\n/u
      )
      expect(message).toContain("2 nested tool calls started before execution stopped:\n- count({'n': 2}) returned {'n': 2}\n- drop({})")
      expect(await runCodeError(code, { code: 'kept' })).toMatch(/Name `kept` used when not defined/u)
      expect(await runCode(code, { code: '(await count(n=3))["n"]' })).toBe(3)
    } finally {
      await remote.close()
      server.close()
    }
  })
})
