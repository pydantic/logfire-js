import type { MontyRemote, MontySession, RemoteCheckoutOptions } from '@pydantic/monty'

import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import { Monty } from '@pydantic/monty'
import { convertToModelMessages, createAgentUIStream, stepCountIs, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { Sandboxes } from './codeMode'

import { withCodeMode } from './withCodeMode'

vi.mock('@pydantic/logfire-agent-sandboxes', () => ({ agentSandboxes: vi.fn<typeof agentSandboxes>() }))

let pool: Monty

beforeAll(async () => {
  pool = await Monty.create({ maxProcesses: 4 })
})

afterAll(async () => {
  await pool.close()
})

const add = tool({
  description: 'Add two numbers.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.object({ sum: z.number() }),
  execute: ({ a, b }) => ({ sum: a + b }),
})

const note = tool({
  description: 'Records a note.',
  inputSchema: z.object({ text: z.string() }),
  execute: () => 'noted',
})

/** Counts checkouts and session closes, so tests can tell whether each call cleaned up its own session. */
class TrackingSandboxes implements Sandboxes {
  checkouts = 0
  closedSessions = 0
  closed = false

  async checkout(options?: RemoteCheckoutOptions): Promise<MontySession> {
    const session = await pool.checkout(options)
    this.checkouts += 1
    const close = session.close.bind(session)
    session.close = async () => {
      this.closedSessions += 1
      await close()
    }
    return session
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.resolve()
  }
}

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

function runCodeCall(toolCallId: string, code: string) {
  return { type: 'tool-call' as const, toolCallId, toolName: 'run_code', input: JSON.stringify({ code }) }
}

function finish(unified: 'stop' | 'tool-calls') {
  return { finishReason: { unified, raw: unified }, usage, warnings: [] }
}

/** A model that runs one snippet per call, picked by the prompt, then answers with the JSON of the output it got back. */
function oneSnippetModel(code: string | ((prompt: string) => string)): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options: CallOptions) => {
      const toolMessage = options.prompt.find((message) => message.role === 'tool')
      if (toolMessage === undefined) {
        const user = options.prompt.find((message) => message.role === 'user')
        const prompt = user?.content[0]?.type === 'text' ? user.content[0].text : ''
        return Promise.resolve({ content: [runCodeCall('call', typeof code === 'string' ? code : code(prompt))], ...finish('tool-calls') })
      }
      return Promise.resolve({ content: [{ type: 'text' as const, text: lastToolOutput(options) }], ...finish('stop') })
    },
  })
}

/** JSON of the output in the latest tool message, as the model received it. */
function lastToolOutput(options: CallOptions): string {
  const part = options.prompt.filter((message) => message.role === 'tool').at(-1)?.content[0]
  return JSON.stringify(part?.type === 'tool-result' ? part.output : null)
}

function parsed(text: string): { type: string; value: unknown } {
  return JSON.parse(text) as { type: string; value: unknown }
}

describe('withCodeMode', () => {
  test('gives each generate() call its own session and closes it when the call ends', async () => {
    const sandboxes = new TrackingSandboxes()
    const model = oneSnippetModel((prompt) => (prompt === 'first' ? 'x = 1\nx' : 'x'))
    const agent = withCodeMode({ model, stopWhen: stepCountIs(3) }, { tools: { add }, sandboxes, typeCheck: 'off' })

    const first = await agent.generate({ prompt: 'first' })
    expect(parsed(first.text)).toEqual({ type: 'json', value: 1 })
    expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([1, 1])

    const second = await agent.generate({ prompt: 'second' })
    const failed = parsed(second.text)
    expect(failed.type).toBe('error-text')
    expect(failed.value).toContain("NameError: name 'x' is not defined")
    expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([2, 2])

    await agent.close()
    expect(sandboxes.closed).toBe(false)
  })

  test('keeps concurrent calls in separate sessions', async () => {
    const sandboxes = new TrackingSandboxes()
    const model = new MockLanguageModelV4({
      doGenerate: async (options: CallOptions) => {
        const user = options.prompt.find((message) => message.role === 'user')
        const name = user?.content[0]?.type === 'text' ? user.content[0].text : ''
        const toolMessages = options.prompt.filter((message) => message.role === 'tool').length
        if (toolMessages === 0) {
          return Promise.resolve({ content: [runCodeCall('set', `owner = '${name}'\nowner`)], ...finish('tool-calls') })
        }
        if (toolMessages === 1) {
          return Promise.resolve({ content: [runCodeCall('get', 'owner')], ...finish('tool-calls') })
        }
        return Promise.resolve({ content: [{ type: 'text' as const, text: lastToolOutput(options) }], ...finish('stop') })
      },
    })
    const agent = withCodeMode({ model, stopWhen: stepCountIs(4) }, { tools: {}, sandboxes })

    const [first, second] = await Promise.all([agent.generate({ prompt: 'alice' }), agent.generate({ prompt: 'bob' })])

    expect(parsed(first.text)).toEqual({ type: 'text', value: 'alice' })
    expect(parsed(second.text)).toEqual({ type: 'text', value: 'bob' })
    expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([2, 2])
  })

  test('closes the session when generate() fails after running code', async () => {
    const sandboxes = new TrackingSandboxes()
    let step = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step += 1
        return step === 1
          ? Promise.resolve({ content: [runCodeCall('call', '1 + 1')], ...finish('tool-calls') })
          : Promise.reject(new Error('the model broke'))
      },
    })
    const agent = withCodeMode({ model, stopWhen: stepCountIs(3), maxRetries: 0 }, { tools: {}, sandboxes })

    await expect(agent.generate({ prompt: 'go' })).rejects.toThrow('the model broke')
    expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([1, 1])
  })

  test('closes the session once a stream() result settles', async () => {
    const sandboxes = new TrackingSandboxes()
    let step = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1
        const first = step === 1
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              if (first) {
                controller.enqueue(runCodeCall('call', '2 * 21'))
                controller.enqueue({ type: 'finish', ...finish('tool-calls') })
              } else {
                controller.enqueue({ type: 'text-start', id: 't' })
                controller.enqueue({ type: 'text-delta', id: 't', delta: 'done' })
                controller.enqueue({ type: 'text-end', id: 't' })
                controller.enqueue({ type: 'finish', ...finish('stop') })
              }
              controller.close()
            },
          }),
        })
      },
    })
    const agent = withCodeMode({ model, stopWhen: stepCountIs(3) }, { tools: {}, sandboxes })

    const result = await agent.stream({ prompt: 'go' })
    expect(await result.text).toBe('done')
    await vi.waitFor(() => {
      expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([1, 1])
    })
  })

  test('adds run_code to tools a prepareCall returns', async () => {
    const sandboxes = new TrackingSandboxes()
    const agent = withCodeMode(
      {
        model: oneSnippetModel('40 + 2'),
        stopWhen: stepCountIs(3),
        tools: { note },
        prepareCall: (args) => ({ ...args, tools: { note } }),
      },
      { tools: {}, sandboxes }
    )

    const { text } = await agent.generate({ prompt: 'go' })

    expect(parsed(text)).toEqual({ type: 'json', value: 42 })
  })

  test('lists run_code in agent.tools, so restored history goes through its model output hook', async () => {
    const sandboxes = new TrackingSandboxes()
    const agent = withCodeMode({ model: oneSnippetModel('1'), tools: { note } }, { tools: { add }, sandboxes })

    expect(Object.keys(agent.tools)).toEqual(['note', 'run_code'])
    const messages = await convertToModelMessages(
      [
        {
          role: 'assistant',
          parts: [
            { type: 'tool-run_code', toolCallId: 'call', state: 'output-available', input: { code: '41 + 1' }, output: { result: 42 } },
          ],
        },
      ],
      { tools: agent.tools }
    )
    expect(messages[1]?.content).toEqual([
      { type: 'tool-result', toolCallId: 'call', toolName: 'run_code', output: { type: 'json', value: 42 } },
    ])
    expect(sandboxes.checkouts).toBe(0)
  })

  test('serves createAgentUIStream with unwrapped run_code history', async () => {
    const sandboxes = new TrackingSandboxes()
    const model = new MockLanguageModelV4({
      doStream: async () =>
        Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 't' })
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'done' })
              controller.enqueue({ type: 'text-end', id: 't' })
              controller.enqueue({ type: 'finish', ...finish('stop') })
              controller.close()
            },
          }),
        }),
    })
    const agent = withCodeMode({ model }, { tools: {}, sandboxes })
    const uiMessages = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] },
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'tool-run_code', toolCallId: 'call', state: 'output-available', input: { code: '41 + 1' }, output: { result: 42 } },
        ],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'again' }] },
    ]

    const chunks = []
    for await (const chunk of await createAgentUIStream({ agent, uiMessages })) {
      chunks.push(chunk.type)
    }

    expect(chunks.at(-1)).toBe('finish')
    const toolMessage = model.doStreamCalls[0]?.prompt.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toEqual([
      { type: 'tool-result', toolCallId: 'call', toolName: 'run_code', output: { type: 'json', value: 42 } },
    ])
  })

  test("gives nested tools the context prepareCall puts under run_code's toolsContext", async () => {
    const sandboxes = new TrackingSandboxes()
    const whoAmI = tool({
      inputSchema: z.object({}),
      outputSchema: z.string(),
      execute: (_input, { context }) => (context as { user: string }).user,
    })
    const model = oneSnippetModel('await who_am_i()')
    const agent = withCodeMode(
      {
        model,
        stopWhen: stepCountIs(3),
        callOptionsSchema: z.object({ user: z.string() }),
        prepareCall: ({ options, ...settings }) => ({ ...settings, toolsContext: { run_code: { who_am_i: { user: options.user } } } }),
      },
      { tools: { who_am_i: whoAmI }, sandboxes, context: { who_am_i: { user: 'nobody' } } }
    )

    const [alice, bob] = await Promise.all([
      agent.generate({ prompt: 'go', options: { user: 'alice' } }),
      agent.generate({ prompt: 'go', options: { user: 'bob' } }),
    ])

    expect(parsed(alice.text)).toEqual({ type: 'text', value: 'alice' })
    expect(parsed(bob.text)).toEqual({ type: 'text', value: 'bob' })
  })

  test('closes the session when a stream fails after running code', async () => {
    const sandboxes = new TrackingSandboxes()
    let step = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1
        if (step > 1) {
          return Promise.reject(new Error('the model broke'))
        }
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(runCodeCall('call', '1 + 1'))
              controller.enqueue({ type: 'finish', ...finish('tool-calls') })
              controller.close()
            },
          }),
        })
      },
    })
    const errors: unknown[] = []
    const onError = ({ error }: { error: unknown }) => {
      errors.push(error)
    }
    const agent = withCodeMode({ model, stopWhen: stepCountIs(3), maxRetries: 0, onError }, { tools: {}, sandboxes })

    const result = await agent.stream({ prompt: 'go' })
    // streamText reports stream errors through onError and resolves text with what arrived before the error.
    expect(await result.text).toBe('')
    expect(errors.map((error) => (error instanceof Error ? error.message : error))).toEqual(['the model broke'])
    await vi.waitFor(() => {
      expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([1, 1])
    })
  })

  test('closes the session when a stream is aborted after running code', async () => {
    const sandboxes = new TrackingSandboxes()
    const controller = new AbortController()
    let step = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1
        if (step > 1) {
          controller.abort()
          return Promise.reject(new DOMException('aborted', 'AbortError'))
        }
        return Promise.resolve({
          stream: new ReadableStream({
            start(streamController) {
              streamController.enqueue(runCodeCall('call', '1 + 1'))
              streamController.enqueue({ type: 'finish', ...finish('tool-calls') })
              streamController.close()
            },
          }),
        })
      },
    })
    const agent = withCodeMode({ model, stopWhen: stepCountIs(3) }, { tools: {}, sandboxes })

    const result = await agent.stream({ prompt: 'go', abortSignal: controller.signal })
    await result.consumeStream()
    await vi.waitFor(() => {
      expect([sandboxes.checkouts, sandboxes.closedSessions]).toEqual([1, 1])
    })
  })

  test('does not run code through the run_code listed in agent.tools', async () => {
    const sandboxes = new TrackingSandboxes()
    const agent = withCodeMode({ model: oneSnippetModel('1') }, { tools: {}, sandboxes })

    await expect(agent.tools.run_code.execute?.({ code: '1' }, { toolCallId: 'call', messages: [], context: undefined })).rejects.toThrow(
      'This run_code belongs to the agent definition. Call agent.generate() or agent.stream() to run code.'
    )
    expect(sandboxes.checkouts).toBe(0)
  })

  test('shares one Agent Sandboxes pool across calls and closes it once', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', 'test-key')
    const tracked = new TrackingSandboxes()
    vi.mocked(agentSandboxes)
      .mockRejectedValueOnce(new Error('could not dial'))
      .mockResolvedValue(tracked as unknown as MontyRemote)
    try {
      const agent = withCodeMode({ model: oneSnippetModel('1'), stopWhen: stepCountIs(3) }, { tools: {}, limits: { timeout: 5000 } })

      await expect(agent.generate({ prompt: 'go' })).rejects.toThrow('could not dial')
      await agent.generate({ prompt: 'go' })
      await agent.generate({ prompt: 'go' })
      expect(vi.mocked(agentSandboxes).mock.calls).toEqual([[{ requestTimeout: 15 }], [{ requestTimeout: 15 }]])
      expect([tracked.checkouts, tracked.closedSessions, tracked.closed]).toEqual([2, 2, false])

      await agent.close()
      await agent.close()
      expect(tracked.closed).toBe(true)
      await expect(agent.generate({ prompt: 'go' })).rejects.toThrow(
        'This code mode agent is closed, so it cannot check out a sandbox session.'
      )
    } finally {
      vi.unstubAllEnvs()
      vi.mocked(agentSandboxes).mockReset()
    }
  })

  test('refuses a direct tool named run_code', () => {
    expect(() =>
      withCodeMode({ model: oneSnippetModel('1'), tools: { run_code: note } }, { tools: {}, sandboxes: new TrackingSandboxes() })
    ).toThrow('The agent\'s tools include "run_code", the name code mode reserves for its own tool. Rename that tool.')
  })

  test('requires a Logfire API key when it creates the pool itself', () => {
    vi.stubEnv('LOGFIRE_API_KEY', '')
    try {
      expect(() => withCodeMode({ model: oneSnippetModel('1') }, { tools: {} })).toThrow(
        'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
          'Set the LOGFIRE_API_KEY environment variable, or pass `sandboxes` to withCodeMode().'
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
