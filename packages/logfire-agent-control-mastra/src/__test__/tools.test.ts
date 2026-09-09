import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { agentControl } from '../index'
import { captureWarnings, callAt, mockModel, nextAgentId, run, text, toolCall, toolsOf, useManagedAgent } from './helpers'

/** The tool names in a prompt or a run's messages, in order, wherever a part names one. */
function historyNames(messages: readonly { content: unknown }[] | undefined): string[] {
  return (messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { toolName?: string }[]).flatMap((part) => (part.toolName === undefined ? [] : [part.toolName]))
      : []
  )
}

const warnings = captureWarnings()

/** An agent with one tool, and a record of every argument its implementation was actually called with. */
function weatherAgent(id: string, model = mockModel(), extraTools: Record<string, unknown> = {}): { agent: Agent; executed: unknown[] } {
  const executed: unknown[] = []
  const getWeather = createTool({
    id: 'get_weather',
    description: 'Get the weather for a city.',
    inputSchema: z.object({ city: z.string().describe('City name') }),
    execute: async (input) => {
      executed.push(input)
      return Promise.resolve({ temp: 21 })
    },
  })
  const agent = new Agent({
    id,
    name: 'A',
    instructions: 'x',
    model,
    tools: { getWeather, ...extraTools } as never,
    inputProcessors: [agentControl()],
  })
  return { agent, executed }
}

describe('the tool definitions section', () => {
  it('renames a tool for the model and for nothing else', async () => {
    const id = nextAgentId()
    useManagedAgent(id, {
      tool_definitions: [{ name: 'getWeather', new_name: 'lookup_weather' }],
    })
    const model = mockModel('mock', 'm', [toolCall('lookup_weather', { city: 'Paris' }), text('done')])
    const { agent, executed } = weatherAgent(id, model)

    const result = await agent.generate('hi')

    expect(result.text).toBe('done')
    // The model is offered the published name and calls it by that name.
    expect(toolsOf(model).map((tool) => tool['name'])).toEqual(['lookup_weather'])
    // Everything on this side of the model boundary keeps the name the code gave it: the tool that
    // ran, the call and result Mastra reports, and the messages it stores for the thread.
    expect(executed).toEqual([expect.objectContaining({ city: 'Paris' })])
    expect(result.toolCalls[0]?.payload.toolName).toBe('getWeather')
    expect(result.steps[0]?.toolResults[0]?.payload.toolName).toBe('getWeather')
    expect(historyNames(result.response.messages)).toEqual(['getWeather', 'getWeather'])
    // And the history those code-side names are replayed from goes out under the published name, so
    // the model is never shown a call to a tool it was not offered.
    expect(historyNames(callAt(model, 1).prompt)).toEqual(['lookup_weather', 'lookup_weather'])
  })

  it('renames the same way through a streamed run', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'lookup_weather' }] })
    const model = mockModel('mock', 'm', [toolCall('lookup_weather', { city: 'Paris' }), text('done')])
    const { agent, executed } = weatherAgent(id, model)

    // Mastra calls the model's other method for a streamed run, and both of them are the boundary.
    const stream = await agent.stream('hi')
    expect(await stream.text).toBe('done')

    const advertised = model.doStreamCalls[0]?.tools ?? []
    expect(advertised.map((tool) => tool.name)).toEqual(['lookup_weather'])
    expect(executed).toEqual([expect.objectContaining({ city: 'Paris' })])
  })

  it('replays a thread through whatever the tool is called now', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'lookup_weather' }] })
    const first = mockModel('mock', 'm1', [toolCall('lookup_weather', { city: 'Paris' }), text('done')])
    const conversation = await weatherAgent(id, first).agent.generate('hi')

    // The rename changes under a thread that was written while the old one was published. Because
    // what Mastra stored is code-side, a resumed thread is translated to the name in force now
    // rather than replaying a name this request does not advertise.
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'fetch_weather' }] })
    const resumed = mockModel('mock', 'm2', [text('resumed')])
    const { agent } = weatherAgent(id, resumed)

    const result = await agent.generate([
      { role: 'user', content: 'hi' },
      ...(conversation.response.messages ?? []),
      { role: 'user', content: 'and now?' },
    ])

    expect(result.text).toBe('resumed')
    expect(toolsOf(resumed).map((tool) => tool['name'])).toEqual(['fetch_weather'])
    expect(historyNames(callAt(resumed, 0).prompt)).toEqual(['fetch_weather', 'fetch_weather'])
  })

  it('replays a thread under the code name once the rename is withdrawn', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'lookup_weather' }] })
    const first = mockModel('mock', 'm1', [toolCall('lookup_weather', { city: 'Paris' }), text('done')])
    const conversation = await weatherAgent(id, first).agent.generate('hi')

    useManagedAgent(id, {})
    const resumed = mockModel('mock', 'm2', [text('resumed')])
    const { agent } = weatherAgent(id, resumed)

    const result = await agent.generate([
      { role: 'user', content: 'hi' },
      ...(conversation.response.messages ?? []),
      { role: 'user', content: 'and now?' },
    ])

    expect(result.text).toBe('resumed')
    expect(toolsOf(resumed).map((tool) => tool['name'])).toEqual(['getWeather'])
    expect(historyNames(callAt(resumed, 0).prompt)).toEqual(['getWeather', 'getWeather'])
  })

  it('carries a forced tool choice across a rename, and leaves an active-tools list alone', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'lookup_weather' }] })
    const model = mockModel()
    const { agent } = weatherAgent(id, model)

    // Both are code-defined choices, written against the name the code gave the tool, and both have
    // to go on meaning what they meant. `activeTools` is filtered against the record, which still
    // carries that name; `toolChoice` reaches the model, so it is translated with the declarations.
    await agent.generate('hi', { toolChoice: { type: 'tool', toolName: 'getWeather' }, activeTools: ['getWeather'] })

    expect(toolsOf(model).map((tool) => tool['name'])).toEqual(['lookup_weather'])
    expect(callAt(model, 0).toolChoice).toEqual({ type: 'tool', toolName: 'lookup_weather' })
  })

  it('advertises no tool at all under a tool choice that forbids one', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'lookup_weather' }] })
    const model = mockModel()
    const { agent } = weatherAgent(id, model)

    // Mastra sends no declarations and no named choice for `'none'`, which the wrapped model has to
    // pass through as the empty call it is rather than reading a rename into it.
    await agent.generate('hi', { toolChoice: 'none' })

    expect(callAt(model, 0).tools).toBeUndefined()
    expect(callAt(model, 0).toolChoice).toEqual({ type: 'none' })
  })

  it('rewrites what the model is told about a tool, and nothing about how it runs', async () => {
    const id = nextAgentId()
    useManagedAgent(id, {
      tool_definitions: [
        {
          name: 'getWeather',
          description: 'Look up the current weather for a city.',
          parameters: { city: { description: "City name, e.g. 'London'" } },
        },
      ],
    })
    const model = mockModel()
    const { agent } = weatherAgent(id, model)

    await run(agent)

    const [tool] = toolsOf(model)
    expect(tool?.['description']).toBe('Look up the current weather for a city.')
    expect(tool?.['inputSchema']).toMatchObject({
      properties: { city: { type: 'string', description: "City name, e.g. 'London'" } },
      required: ['city'],
    })
  })

  it('leaves a schema alone where an override names a parameter the tool does not have', async () => {
    const id = nextAgentId()
    useManagedAgent(id, {
      tool_definitions: [{ name: 'getWeather', parameters: { country: { description: 'No.' } } }],
    })
    const model = mockModel()
    const { agent } = weatherAgent(id, model)

    await run(agent)

    expect(toolsOf(model)[0]?.['inputSchema']).toMatchObject({ properties: { city: { description: 'City name' } } })
  })

  it('reports an override that patches a tool this request does not advertise', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'sendEmail', description: 'Nowhere.' }] })
    const model = mockModel()
    const { agent } = weatherAgent(id, model)

    await run(agent)

    expect(warnings.messages).toEqual([expect.stringContaining("patches tool 'sendEmail', which no toolset advertises for this request")])
  })

  it('keeps every tool callable when a rename collides with another tool', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', new_name: 'getForecast' }] })
    const model = mockModel()
    const getForecast = createTool({
      id: 'get_forecast',
      description: 'Forecast.',
      inputSchema: z.object({ city: z.string() }),
      execute: async () => Promise.resolve({ temp: 21 }),
    })
    const getWeather = createTool({
      id: 'get_weather',
      description: 'Weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: async () => Promise.resolve({ temp: 21 }),
    })
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model,
      tools: { getWeather, getForecast },
      inputProcessors: [agentControl()],
    })

    await run(agent)

    expect(toolsOf(model).map((tool) => tool['name'])).toEqual(['getWeather', 'getForecast'])
    expect(warnings.messages).toEqual([
      expect.stringContaining("renames 'getWeather' to 'getForecast', which is already advertised by another tool"),
    ])
  })

  it('holds a provider-defined tool out of the overlay, and holds its name against a rename', async () => {
    const id = nextAgentId()
    useManagedAgent(id, {
      tool_definitions: [
        { name: 'getWeather', new_name: 'web_search' },
        { name: 'web_search', description: "Not this adapter's to describe." },
      ],
    })
    const model = mockModel()
    const { agent } = weatherAgent(id, model, {
      // A provider-executed tool: its name is a contract with the provider rather than a description
      // the model reads, so it is neither described nor renamed, and nothing may take its name.
      search: { type: 'provider-defined', id: 'openai.web_search', name: 'web_search', args: {} },
    })

    await run(agent)

    expect(toolsOf(model).map((tool) => tool['name'])).toEqual(['getWeather', 'web_search'])
    expect(warnings.messages).toEqual([
      expect.stringContaining("renames 'getWeather' to 'web_search', which is already advertised by another tool"),
      expect.stringContaining("patches tool 'web_search', which no toolset advertises for this request"),
    ])
  })

  it('advertises the code-defined tools untouched when nothing matches', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [] })
    const model = mockModel()
    const { agent } = weatherAgent(id, model)

    await run(agent)

    expect(toolsOf(model)).toMatchObject([{ name: 'getWeather', description: 'Get the weather for a city.' }])
  })
})
