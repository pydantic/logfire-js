import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider'
import { generateText, stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { UnmatchedConfigError, agentControl } from '../index'
import {
  captureWarnings,
  publishedValue,
  stubModel,
  textResult,
  textStream,
  toolCallResult,
  toolCallStream,
  useLocalVariables,
} from './helpers'

const warnings = captureWarnings()

const executed: string[] = []
const time = tool({
  description: 'The current time.',
  inputSchema: z.object({}),
  execute: async () => Promise.resolve('noon'),
})
const weather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string().describe('City to look up.') }),
  execute: async ({ city }: { city: string }) => {
    executed.push(city)
    return Promise.resolve(`sunny in ${city}`)
  },
})

/** The tools the model was actually shown on a given call. */
function shownTools(model: { doGenerateCalls: { tools?: unknown[] }[] }, call = 0): LanguageModelV4FunctionTool[] {
  return (model.doGenerateCalls[call]?.tools ?? []) as LanguageModelV4FunctionTool[]
}

describe('tool definitions', () => {
  it('rewrites the description and the parameter descriptions the model is shown', async () => {
    useLocalVariables(
      publishedValue('agent__tool_text', {
        tool_definitions: [
          {
            name: 'get_weather',
            description: 'Look up the current weather for a city.',
            parameters: { city: { description: "City name, e.g. 'London'." } },
          },
        ],
      })
    )
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'tool_text', label: 'production' }),
      prompt: 'hi',
      tools: { get_weather: weather },
    })

    const [shown] = shownTools(model)
    expect(shown?.description).toBe('Look up the current weather for a city.')
    expect(shown?.inputSchema.properties?.['city']).toMatchObject({ description: "City name, e.g. 'London'." })
    // Structure other than the descriptions is code-defined and untouched.
    expect(shown?.inputSchema.required).toEqual(['city'])
  })

  it('routes a call to a renamed tool back to the code implementation, with its arguments', async () => {
    useLocalVariables(
      publishedValue('agent__renamed', {
        tool_definitions: [{ name: 'get_weather', new_name: 'lookup_weather' }],
      })
    )
    executed.length = 0
    const model = stubModel([toolCallResult('lookup_weather', { city: 'Paris' }), textResult('sunny')])
    const result = await generateText({
      model: agentControl({ model, name: 'renamed', label: 'production' }),
      prompt: 'weather in Paris?',
      stopWhen: stepCountIs(3),
      tools: { get_weather: weather },
    })

    expect(shownTools(model)[0]?.name).toBe('lookup_weather')
    // The tool ran, with the arguments the model sent under the managed name.
    expect(executed).toEqual(['Paris'])
    expect(result.steps[0]?.toolResults).toEqual([expect.objectContaining({ toolName: 'get_weather', output: 'sunny in Paris' })])
    // Nothing user-facing ever sees the managed name.
    expect(result.steps[0]?.content.map((part) => ('toolName' in part ? part.toolName : part.type))).toEqual(['get_weather', 'get_weather'])
  })

  it('re-renames the history the SDK writes back, so the model sees one consistent tool set', async () => {
    useLocalVariables(
      publishedValue('agent__renamed_history', {
        tool_definitions: [{ name: 'get_weather', new_name: 'lookup_weather' }],
      })
    )
    const model = stubModel([toolCallResult('lookup_weather', { city: 'Paris' }), textResult('sunny')])
    await generateText({
      model: agentControl({ model, name: 'renamed_history', label: 'production' }),
      prompt: 'weather in Paris?',
      stopWhen: stepCountIs(3),
      tools: { get_weather: weather },
    })

    const second = model.doGenerateCalls[1]?.prompt ?? []
    const names = second.flatMap((message) =>
      Array.isArray(message.content) ? message.content.flatMap((part) => ('toolName' in part ? [part.toolName] : [])) : []
    )
    // Both the assistant's call and the tool's result carry the name the tools array advertises.
    expect(names).toEqual(['lookup_weather', 'lookup_weather'])
    expect(shownTools(model, 1)[0]?.name).toBe('lookup_weather')
  })

  it('routes a renamed tool call back through a stream too', async () => {
    useLocalVariables(
      publishedValue('agent__renamed_stream', {
        tool_definitions: [{ name: 'get_weather', new_name: 'lookup_weather' }],
      })
    )
    executed.length = 0
    const model = stubModel([toolCallStream('lookup_weather', { city: 'Berlin' }), textStream('sunny')])
    const errors: unknown[] = []
    const stream = streamText({
      model: agentControl({ model, name: 'renamed_stream', label: 'production' }),
      prompt: 'weather in Berlin?',
      stopWhen: stepCountIs(3),
      tools: { get_weather: weather },
      onError: ({ error }) => errors.push(error),
    })

    expect(await stream.text).toBe('sunny')
    expect(errors).toEqual([])
    expect(executed).toEqual(['Berlin'])
    const steps = await stream.steps
    expect(steps[0]?.toolResults).toEqual([expect.objectContaining({ toolName: 'get_weather', output: 'sunny in Berlin' })])
  })

  it('leaves a provider-defined tool alone and refuses to rename onto its name', async () => {
    useLocalVariables(
      publishedValue('agent__provider_tool', {
        tool_definitions: [{ name: 'get_weather', new_name: 'web_search', description: 'Still patched.' }],
      })
    )
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'provider_tool', label: 'production' }),
      prompt: 'hi',
      tools: {
        get_weather: weather,
        web_search: {
          type: 'provider' as const,
          id: 'anthropic.web_search' as const,
          args: {},
          isProviderExecuted: true as const,
          inputSchema: z.object({ query: z.string() }),
        },
      },
    })

    const shown = shownTools(model)
    expect(shown.map((entry) => entry.name)).toEqual(['get_weather', 'web_search'])
    // The rename is dropped and the rest of the override still applies, so every tool stays callable.
    expect(shown[0]?.description).toBe('Still patched.')
    // Reported by the core under the caller's policy, because the provider tool's name was handed to
    // it as reserved -- rather than by a warning of this adapter's own that `'ignore'` would not
    // silence and `'error'` would not fail on.
    expect(warnings.messages).toContainEqual(expect.stringContaining('already advertised by another tool'))
  })

  it('fails the run on a refused rename when told to, and silences it when told to', async () => {
    useLocalVariables(
      publishedValue('agent__collision_policy', {
        tool_definitions: [{ name: 'get_weather', new_name: 'get_time' }],
      })
    )
    const model = stubModel([textResult('ok'), textResult('ok')])
    // The collision is with another *function* tool, which only the core can see -- and it reaches
    // the caller's policy rather than a warning of this adapter's own, so `'error'` fails on it.
    await expect(
      generateText({
        model: agentControl({ model, name: 'collision_policy', label: 'production', onUnmatched: 'error' }),
        prompt: 'hi',
        tools: { get_weather: weather, get_time: time },
      })
    ).rejects.toBeInstanceOf(UnmatchedConfigError)

    await generateText({
      model: agentControl({ model, name: 'collision_policy', label: 'production', onUnmatched: 'ignore' }),
      prompt: 'hi',
      tools: { get_weather: weather, get_time: time },
    })
    expect(shownTools(model).map((entry) => entry.name)).toEqual(['get_weather', 'get_time'])
    expect(warnings.messages).toEqual([])
  })

  it('carries a forced tool choice across the rename it names', async () => {
    useLocalVariables(
      publishedValue('agent__forced_choice', {
        tool_definitions: [{ name: 'get_weather', new_name: 'lookup_weather' }],
      })
    )
    executed.length = 0
    const model = stubModel([toolCallResult('lookup_weather', { city: 'Paris' })])
    await generateText({
      model: agentControl({ model, name: 'forced_choice', label: 'production' }),
      prompt: 'weather in Paris?',
      stopWhen: stepCountIs(1),
      tools: { get_weather: weather },
      toolChoice: { type: 'tool', toolName: 'get_weather' },
    })

    // The code forced a tool the model is no longer shown under that name; a provider handed a choice
    // naming a tool it was not offered rejects the request outright.
    expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: 'tool', toolName: 'lookup_weather' })
    expect(executed).toEqual(['Paris'])
  })

  it.each([
    [{ type: 'tool', toolName: 'get_time' } as const, { type: 'tool', toolName: 'get_time' }, 'unrenamed_choice'],
    ['required' as const, { type: 'required' }, 'required_choice'],
  ])('leaves a tool choice that names no renamed tool alone (%#)', async (toolChoice, expected, name) => {
    useLocalVariables(publishedValue(`agent__${name}`, { tool_definitions: [{ name: 'get_weather', new_name: 'lookup_weather' }] }))
    const model = stubModel([toolCallResult('get_time', {})])
    await generateText({
      model: agentControl({ model, name, label: 'production' }),
      prompt: 'hi',
      stopWhen: stepCountIs(1),
      tools: { get_weather: weather, get_time: time },
      toolChoice,
    })

    expect(model.doGenerateCalls[0]?.toolChoice).toEqual(expected)
  })

  it('reports a tool override nothing advertises, and fails the run when told to', async () => {
    useLocalVariables(publishedValue('agent__unmatched_tool', { tool_definitions: [{ name: 'nope', description: 'Unreachable.' }] }))
    const model = stubModel([textResult('ok'), textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'unmatched_tool', label: 'production' }),
      prompt: 'hi',
      tools: { get_weather: weather },
    })
    expect(warnings.messages).toContainEqual(expect.stringContaining("tool 'nope'"))

    await expect(
      generateText({
        model: agentControl({ model, name: 'unmatched_tool', label: 'production', onUnmatched: 'error' }),
        prompt: 'hi',
        tools: { get_weather: weather },
      })
    ).rejects.toBeInstanceOf(UnmatchedConfigError)
  })

  it('reports an override qualified by a toolset, which this SDK has no grouping for', async () => {
    useLocalVariables(
      publishedValue('agent__toolset_override', {
        tool_definitions: [{ name: 'get_weather', toolset: 'crm', description: 'Never applied.' }],
      })
    )
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'toolset_override', label: 'production' }),
      prompt: 'hi',
      tools: { get_weather: weather },
    })

    expect(shownTools(model)[0]?.description).toBe('Get the current weather for a city.')
    expect(warnings.messages).toContainEqual(expect.stringContaining("toolset 'crm'"))
  })

  it('leaves a request with no tools alone', async () => {
    useLocalVariables(publishedValue('agent__no_tools', { tool_definitions: [{ name: 'get_weather', description: 'Unreachable.' }] }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'no_tools', label: 'production', onUnmatched: 'ignore' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.tools).toBeUndefined()
  })
})
