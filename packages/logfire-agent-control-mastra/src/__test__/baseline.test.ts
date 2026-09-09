import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { getVariableProvider } from '@pydantic/logfire-node/vars'
import type { VariableConfig } from '@pydantic/logfire-node/vars'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { agentControl } from '../index'
import { captureWarnings, mockModel, nextAgentId, run, settle, useLocalVariables } from './helpers'

captureWarnings()

/** The variable definition the adapter published for `agentId`. */
function publishedVariable(agentId: string): VariableConfig | undefined {
  const provider = getVariableProvider()
  return provider.getVariableConfig?.(`agent__${agentId}`) as VariableConfig | undefined
}

/** The baseline the adapter published for `agentId`, as the JSON that reached the variable. */
function publishedBaseline(agentId: string): string {
  return publishedVariable(agentId)?.example ?? ''
}

const getWeather = createTool({
  id: 'get_weather',
  description: 'Get the weather for a city.',
  inputSchema: z.object({
    city: z.string().describe('City name'),
    unit: z.enum(['c', 'f']).optional().describe('Temperature unit'),
  }),
  execute: async () => Promise.resolve({ temp: 21 }),
})

describe('the published baseline', () => {
  it('describes the agent as written, in the contract order', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const agent = new Agent({
      id,
      name: 'Checkout Assistant',
      instructions: ['You are a concise checkout assistant.', 'Always confirm the order total.'],
      model: mockModel('anthropic.messages', 'claude-fable-5-1'),
      tools: { getWeather },
      defaultOptions: {
        modelSettings: { temperature: 0.2, maxOutputTokens: 100, timeout: { stepMs: 30_000 } },
        providerOptions: { openai: { parallelToolCalls: false } },
      },
      inputProcessors: [agentControl()],
    })

    await run(agent)
    await settle()

    // Compared as the exact string, not as a parsed object: this is what someone reads in the Logfire
    // editor, so the order of the keys and the shape of each entry are part of what is being tested.
    expect(publishedBaseline(id)).toBe(
      JSON.stringify(
        {
          instructions: [
            { id: 'agent:0', instructions: 'You are a concise checkout assistant.', dynamic: false },
            { id: 'agent:1', instructions: 'Always confirm the order total.', dynamic: false },
          ],
          model: 'anthropic:claude-fable-5-1',
          settings: { max_tokens: 100, temperature: 0.2, parallel_tool_calls: false, timeout: 30 },
          tool_definitions: [
            {
              name: 'getWeather',
              description: 'Get the weather for a city.',
              parameters: { city: { description: 'City name' }, unit: { description: 'Temperature unit' } },
            },
          ],
        },
        null,
        2
      )
    )
  })

  it('says it was snapshotted from one request, because the tool list was', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model: mockModel(),
      tools: { getWeather },
      inputProcessors: [agentControl()],
    })

    await run(agent)
    await settle()

    // The agent's own text, model and settings are read off the agent, but the tools the model is
    // offered are only assembled per request -- a request carrying a memory, workspace or MCP toolset
    // assembles a different list -- so the whole baseline is published as the observation it is.
    expect(publishedVariable(id)?.description).toContain('snapshotted from one request')
  })

  it('gives a lone instruction string the reserved `agent` id', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'You are helpful.',
      model: mockModel('openai.responses', 'gpt-5.6-sol'),
      inputProcessors: [agentControl()],
    })

    await run(agent)
    await settle()

    expect(JSON.parse(publishedBaseline(id))).toEqual({
      instructions: [{ id: 'agent', instructions: 'You are helpful.', dynamic: false }],
      model: 'openai:gpt-5.6-sol',
    })
  })

  it('publishes the seam of instructions that are computed per request, never their text', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const agent = new Agent({
      id,
      name: 'A',
      // The tenant's name is exactly the kind of thing a baseline every project member can read must
      // not carry, and exactly what a computed block is usually built from.
      instructions: ({ requestContext }) => `You serve ${String(requestContext.get('tenant') ?? 'nobody')}.`,
      model: mockModel(),
      inputProcessors: [agentControl()],
    })

    await run(agent)
    await settle()

    expect(JSON.parse(publishedBaseline(id))).toEqual({
      instructions: [{ id: 'agent', dynamic: true }],
      model: 'mock:mock-model',
    })
  })

  it('leaves out a model it cannot name once, rather than pinning one sample of it', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model: () => model,
      inputProcessors: [agentControl()],
    })

    await run(agent)
    await settle()

    const baseline = JSON.parse(publishedBaseline(id)) as Record<string, unknown>
    expect(baseline['model']).toBeUndefined()
    expect(baseline['instructions']).toEqual([{ id: 'agent', instructions: 'x', dynamic: false }])
  })

  it('describes what the code says even when a per-run option replaced it', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'Code instructions.',
      model: mockModel(),
      inputProcessors: [agentControl()],
    })

    await agent.generate('hi', { instructions: 'Per-run instructions.' })
    await settle()

    expect(JSON.parse(publishedBaseline(id))).toMatchObject({
      instructions: [{ id: 'agent', instructions: 'Code instructions.', dynamic: false }],
    })
  })

  it('can be switched off for a read-only token', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model: mockModel(),
      inputProcessors: [agentControl({ publishBaseline: false })],
    })

    await run(agent)
    await settle()

    expect(publishedBaseline(id)).toBe('')
  })
})
