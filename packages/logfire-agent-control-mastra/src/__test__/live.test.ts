/**
 * What a real provider does with a published config, recorded once and replayed offline.
 *
 * The rest of this suite proves what the adapter hands Mastra. These tests are the other half: that
 * what Mastra then puts on the wire is what the provider is willing to act on. Every assertion is on
 * a request this run actually built -- the cassette supplies the response, never the request -- so a
 * change that stops a published value from reaching the provider fails here rather than in a bill.
 *
 * See `./cassette.ts` for the recorder and how to re-record.
 */

import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { agentControl } from '../index'
import { useCassette } from './cassette'
import { captureWarnings, nextAgentId, useManagedAgent } from './helpers'

const warnings = captureWarnings()

/**
 * The cheapest current model of each provider, named as Mastra's router names it.
 *
 * Both are in `PROVIDER_REGISTRY`, which is what `isRoutableModelId` checks, so these ids are the
 * ones a published `openai:gpt-5.4-nano` or `anthropic:claude-haiku-4-5` translates to.
 */
const OPENAI = 'openai/gpt-5.4-nano'
const ANTHROPIC = 'anthropic/claude-haiku-4-5'

/** The tool the rename and settings tests offer, whose record key is what the code calls it. */
function weatherTool(): ReturnType<typeof createTool> {
  return createTool({
    id: 'get_weather',
    description: 'Get the weather for a city.',
    inputSchema: z.object({ city: z.string().describe('City name') }),
    execute: async ({ city }: { city: string }) => Promise.resolve({ city, temperatureC: 21 }),
  })
}

/** Every canonical setting at once, so one request says which of them a provider takes. */
const ALL_SETTINGS = {
  max_tokens: 512,
  temperature: 0.2,
  top_p: 0.5,
  top_k: 20,
  seed: 42,
  presence_penalty: 0.3,
  frequency_penalty: 0.3,
  stop_sequences: ['###NEVER###'],
  timeout: 60,
  thinking: 'low',
  parallel_tool_calls: false,
} as const

/** The features an AI SDK provider said it could not honor, which is how a dropped setting is visible. */
function unsupported(result: { warnings?: unknown }): string[] {
  const list = (result.warnings ?? []) as { type?: string; feature?: string }[]
  return list
    .filter((warning) => warning.type === 'unsupported')
    .map((warning) => warning.feature ?? '')
    .sort((left, right) => left.localeCompare(right))
}

describe('against a real provider', () => {
  it('sends a published instruction block, and the model answers to it', async () => {
    const wire = useCassette('instructions-openai', 'openai')
    const id = nextAgentId()
    useManagedAgent(id, {
      instructions: [{ id: 'agent', instructions: 'Reply with exactly the word BANANA, nothing else.' }],
    })
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'You are a helpful assistant.',
      model: OPENAI,
      inputProcessors: [agentControl()],
    })

    const result = await agent.generate('What is the capital of France?')

    // The published text is the system prompt the provider received, and the code's own text is gone
    // from the request rather than sitting alongside it.
    expect(wire.request(0)['input']).toEqual([
      { role: 'developer', content: 'Reply with exactly the word BANANA, nothing else.' },
      { role: 'user', content: [{ type: 'input_text', text: 'What is the capital of France?' }] },
    ])
    // And it is what the model did, which no offline test can show.
    expect(result.text).toBe('BANANA')
  })

  it('advertises a renamed tool, and dispatches the call under the code name', async () => {
    const wire = useCassette('tool-rename-openai', 'openai')
    const seen: { city: string }[] = []
    const getWeather = createTool({
      id: 'get_weather',
      description: 'Get the weather for a city.',
      inputSchema: z.object({ city: z.string().describe('City name') }),
      execute: async (input: { city: string }) => {
        seen.push(input)
        return Promise.resolve({ city: input.city, temperatureC: 21 })
      },
    })
    const id = nextAgentId()
    useManagedAgent(id, {
      tool_definitions: [
        {
          name: 'getWeather',
          new_name: 'lookup_current_weather',
          description: 'Look up the current weather for a city.',
          parameters: { city: { description: "The city to look up, for example 'Paris'." } },
        },
      ],
    })
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'Use your tools to answer.',
      model: OPENAI,
      tools: { getWeather },
      inputProcessors: [agentControl()],
    })

    const result = await agent.generate('What is the weather in Paris?')

    // On the wire: the managed name, the managed description, and the reworded parameter description
    // inside the schema the code declared.
    expect(wire.request(0)['tools']).toEqual([
      {
        type: 'function',
        name: 'lookup_current_weather',
        description: 'Look up the current weather for a city.',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { city: { type: 'string', description: "The city to look up, for example 'Paris'." } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    ])
    // The model called it under that name, and the second request replays the history forward under
    // the managed name too -- which is what keeps a stored thread readable to the provider.
    const input = wire.request(1)['input'] as Record<string, unknown>[]
    const replayed = input.filter((item) => item['type'] === 'function_call')
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.['name']).toBe('lookup_current_weather')
    expect(replayed[0]?.['arguments']).toBe('{"city":"Paris"}')

    // On this side of the boundary nothing knows about the rename: the code's `execute` ran with the
    // arguments the model sent, and everything Mastra records reads `getWeather`.
    expect(seen).toEqual([{ city: 'Paris' }])
    expect(result.toolCalls.map((call) => call.payload.toolName)).toEqual(['getWeather'])
    expect(toolNamesIn(result.response.messages ?? [])).toEqual(['getWeather', 'getWeather'])
  })

  it("takes the settings OpenAI's Responses API accepts, and reports what it drops", async () => {
    const wire = useCassette('settings-openai', 'openai')
    const id = nextAgentId()
    useManagedAgent(id, { settings: ALL_SETTINGS })
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'Answer in one word.',
      model: OPENAI,
      tools: { getWeather: weatherTool() },
      inputProcessors: [agentControl()],
    })

    const result = await agent.generate('Capital of France?')

    // Two of the eleven reach the request. `parallel_tool_calls` is the one that only exists as a
    // provider option, which is the mapping this proves.
    expect(wire.request(0)['max_output_tokens']).toBe(512)
    expect(wire.request(0)['parallel_tool_calls']).toBe(false)
    // Six the provider itself refuses. `temperature` and `top_p` it refuses only for its reasoning
    // models, which every current GPT-5 is; the other four the Responses API has no field for at all.
    expect(unsupported(result)).toEqual(['frequencyPenalty', 'presencePenalty', 'seed', 'stopSequences', 'temperature', 'topK', 'topP'])
    // `timeout` is Mastra's own budget and is not a request field; `thinking` cannot be applied at
    // all through the model router, and the adapter says so rather than dropping it in silence.
    expect(wire.request(0)['timeout']).toBeUndefined()
    expect(warnings.messages).toEqual([expect.stringContaining("Managed agent config sets 'thinking'")])
  })

  it('takes the settings Anthropic accepts, and reports what it drops', async () => {
    const wire = useCassette('settings-anthropic', 'anthropic')
    const id = nextAgentId()
    useManagedAgent(id, { settings: ALL_SETTINGS })
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'Answer in one word.',
      model: ANTHROPIC,
      tools: { getWeather: weatherTool() },
      inputProcessors: [agentControl()],
    })

    const result = await agent.generate('Capital of France?')

    expect(wire.request(0)['max_tokens']).toBe(512)
    expect(wire.request(0)['temperature']).toBe(0.2)
    expect(wire.request(0)['top_k']).toBe(20)
    expect(wire.request(0)['stop_sequences']).toEqual(['###NEVER###'])
    // The inverted polarity of the `parallel_tool_calls` mapping, as Anthropic spells it.
    expect(wire.request(0)['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    // `top_p` is the one that depends on its company: Anthropic asks callers not to send it together
    // with `temperature`, and the AI SDK provider drops it when both are published. Alone it applies.
    expect(wire.request(0)['top_p']).toBeUndefined()
    expect(unsupported(result)).toEqual(['frequencyPenalty', 'presencePenalty', 'seed', 'topP'])
    expect(warnings.messages).toEqual([expect.stringContaining("Managed agent config sets 'thinking'")])
  })
})

/** Every tool name in a run's response messages, which is the set a thread is stored from. */
function toolNamesIn(messages: readonly unknown[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) {
      continue
    }
    for (const part of content as { toolName?: unknown }[]) {
      if (typeof part.toolName === 'string') {
        names.push(part.toolName)
      }
    }
  }
  return names
}
