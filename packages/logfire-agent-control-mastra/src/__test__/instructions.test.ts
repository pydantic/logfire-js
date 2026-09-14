import { Agent } from '@mastra/core/agent'
import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import { captureWarnings, mockModel, nextAgentId, run, systemPrompt, useManagedAgent } from './helpers'

const warnings = captureWarnings()

/** An agent whose two instruction blocks are the ones a published value addresses by index. */
function twoBlockAgent(id: string, model = mockModel()): Agent {
  return new Agent({
    id,
    name: 'A',
    instructions: ['You are a concise checkout assistant.', 'Always confirm the order total.'],
    model,
    inputProcessors: [agentControl()],
  })
}

describe('the instructions section', () => {
  it('rewrites the block an id names and leaves its neighbours alone', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:0', instructions: 'You are a refund specialist.' }] })
    const model = mockModel()

    await run(twoBlockAgent(id, model))

    expect(systemPrompt(model)).toEqual(['You are a refund specialist.', 'Always confirm the order total.'])
  })

  it('addresses a lone instruction string as `agent`', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent', instructions: 'Rewritten.' }] })
    const model = mockModel()
    const agent = new Agent({ id, name: 'A', instructions: 'Original.', model, inputProcessors: [agentControl()] })

    await run(agent)

    expect(systemPrompt(model)).toEqual(['Rewritten.'])
  })

  it('addresses a block by the id its entry declares, wherever the entry sits', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'persona', instructions: 'You are a refund specialist.' }] })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      // Declared second, and addressed as `persona` rather than as `agent:1` -- which is the point:
      // moving it back to the front does not re-point the override at the other block.
      instructions: [
        { role: 'system' as const, content: 'Always confirm the order total.' },
        {
          role: 'system' as const,
          content: 'You are a concise checkout assistant.',
          providerOptions: { logfire: { id: 'persona' } },
        },
      ],
      model,
      inputProcessors: [agentControl()],
    })

    await run(agent)

    expect(systemPrompt(model)).toEqual(['Always confirm the order total.', 'You are a refund specialist.'])
  })

  it('keeps an entry that declares an id in the reserved `tag:` namespace, under its position', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: ['Added.'] })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: [
        // `tag:` names Mastra's own buckets, and a block carrying one is dropped from the prompt
        // rather than sent -- so an entry claiming one keeps its positional id instead.
        { role: 'system' as const, content: 'Persona.', providerOptions: { logfire: { id: 'tag:persona' } } },
        { role: 'system' as const, content: 'Second.' },
      ],
      model,
      inputProcessors: [agentControl()],
    })

    await run(agent)

    expect(systemPrompt(model)).toEqual(['Persona.', 'Second.', 'Added.'])
    expect(warnings.messages).toEqual([])
  })

  it('refuses an id two entries both declare, rather than letting one override rewrite both', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'persona', instructions: 'Rewritten.' }] })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: [
        { role: 'system' as const, content: 'First.', providerOptions: { logfire: { id: 'persona' } } },
        { role: 'system' as const, content: 'Second.', providerOptions: { logfire: { id: 'persona' } } },
      ],
      model,
      inputProcessors: [agentControl()],
    })

    await run(agent)

    // Both fall back to their positional ids, so the ambiguous id addresses nothing and is reported;
    // the alternative is one of the two winning by declaration order, silently.
    expect(systemPrompt(model)).toEqual(['First.', 'Second.'])
    expect(warnings.messages).toEqual([
      expect.stringContaining("addresses instruction block 'persona', which this request does not assemble"),
    ])
  })

  it("adds a block after the agent's own text and before what Mastra adds per request", async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: 'Escalate anything over $500 to a human.' })
    const model = mockModel()

    // The caller's `system` option lands in a tagged bucket, which the model sees after the untagged
    // one: an added block must go before it, or every request would push the cached prefix along.
    await twoBlockAgent(id, model).generate('hi', { system: 'Today is Tuesday.' })

    expect(systemPrompt(model)).toEqual([
      'You are a concise checkout assistant.',
      'Always confirm the order total.',
      'Escalate anything over $500 to a human.',
      'Today is Tuesday.',
    ])
  })

  it('drops a block whose entry publishes no text', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:1', instructions: null }] })
    const model = mockModel()

    await run(twoBlockAgent(id, model))

    expect(systemPrompt(model)).toEqual(['You are a concise checkout assistant.'])
  })

  it('stands down where a per-run `instructions` option replaced the code it addresses', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:0', instructions: 'Managed.' }] })
    const model = mockModel()

    await twoBlockAgent(id, model).generate('hi', { instructions: 'Per-run instructions.' })

    // Per-run beats published: the ids no longer name the blocks they were written against, so the
    // section applies to nothing rather than to whatever happens to be at index 0 -- and says so,
    // rather than leaving someone to wonder why what they published did nothing.
    expect(systemPrompt(model)).toEqual(['Per-run instructions.'])
    expect(warnings.messages).toEqual([expect.stringContaining('this request passed its own `instructions:` option')])
  })

  it('stands down, and says what to fix, where two of the code blocks are identical', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:1', instructions: 'Managed.' }] })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      // Mastra's `MessageList` drops the duplicate, so `agent:1` would land on whatever followed it.
      instructions: ['Say it once.', 'Say it once.', 'And then stop.'],
      model,
      inputProcessors: [agentControl()],
    })

    await run(agent)

    expect(systemPrompt(model)).toEqual(['Say it once.', 'And then stop.'])
    expect(warnings.messages).toEqual([expect.stringContaining("two of this agent's own instruction blocks are identical")])
  })

  it('refuses to rewrite instructions the agent computes per request', async () => {
    const id = nextAgentId()
    useManagedAgent(id, {
      instructions: [{ id: 'agent', instructions: 'Pinned.' }, 'Escalate anything over $500 to a human.'],
    })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: ({ requestContext }) => `You serve ${String(requestContext.get('tenant') ?? 'nobody')}.`,
      model,
      inputProcessors: [agentControl()],
    })

    await run(agent)

    // The computed block keeps what the code produces; the added block still applies, before it,
    // because an added block never moves an existing one.
    expect(systemPrompt(model)).toEqual(['Escalate anything over $500 to a human.', 'You serve nobody.'])
    expect(warnings.messages).toEqual([
      expect.stringContaining("addresses instruction block 'agent', which the agent recomputes per request"),
    ])
  })

  it("describes Mastra's own tagged prompt sections without touching them", async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'tag:user-provided', instructions: 'Rewritten.' }] })
    const model = mockModel()

    await twoBlockAgent(id, model).generate('hi', { system: 'Today is Tuesday.' })

    expect(systemPrompt(model)).toEqual(['You are a concise checkout assistant.', 'Always confirm the order total.', 'Today is Tuesday.'])
    expect(warnings.messages).toEqual([
      expect.stringContaining("addresses instruction block 'tag:user-provided', which the agent recomputes per request"),
    ])
  })

  it('reports an id that names no block in this request', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:7', instructions: 'Nowhere.' }] })
    const model = mockModel()

    await run(twoBlockAgent(id, model))

    expect(systemPrompt(model)).toEqual(['You are a concise checkout assistant.', 'Always confirm the order total.'])
    expect(warnings.messages).toEqual([
      expect.stringContaining("addresses instruction block 'agent:7', which this request does not assemble"),
    ])
  })

  it("fails the run instead, under `onUnmatched: 'error'`", async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:7', instructions: 'Nowhere.' }] })
    const agent = new Agent({
      id,
      name: 'A',
      instructions: ['One.'],
      model: mockModel(),
      inputProcessors: [agentControl({ onUnmatched: 'error' })],
    })

    // The run fails, but not with `UnmatchedConfigError` itself: Mastra runs input processors as a
    // workflow and wraps whatever a step throws in a `PROCESSOR_WORKFLOW_FAILED` error, keeping the
    // message. So the policy stops the run, and what it says survives; the class does not.
    await expect(run(agent)).rejects.toThrow(
      /Managed agent config addresses instruction block 'agent:7', which this request does not assemble/u
    )
  })

  it("says nothing under `onUnmatched: 'ignore'`", async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:7', instructions: 'Nowhere.' }] })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: ['One.'],
      model,
      inputProcessors: [agentControl({ onUnmatched: 'ignore' })],
    })

    await run(agent)

    expect(systemPrompt(model)).toEqual(['One.'])
    expect(warnings.messages).toEqual([])
  })

  it('applies the same value to every step of a run', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent:0', instructions: 'Managed.' }] })
    const model = mockModel('mock', 'm', [
      {
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as never,
      {
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as never,
    ])
    const agent = new Agent({
      id,
      name: 'A',
      instructions: ['Original.', 'Second.'],
      model,
      tools: {
        noop: {
          id: 'noop',
          description: 'Does nothing.',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => Promise.resolve('done'),
        },
      },
      inputProcessors: [agentControl()],
    })

    await run(agent)

    // The prompt prefix is identical on both calls: an adapter that resolved per step, or that
    // appended to what the previous step returned, would move the provider's cache boundary.
    expect(systemPrompt(model, 0)).toEqual(['Managed.', 'Second.'])
    expect(systemPrompt(model, 1)).toEqual(['Managed.', 'Second.'])
    // And nothing is reported on the second step. Mastra rebuilds a step's system messages from the
    // agent rather than from what the previous step returned, so the already-managed text is never
    // compared against the code's and read as a per-run option that replaced it.
    expect(warnings.messages).toEqual([])
  })
})
