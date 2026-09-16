import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { agentControl } from '../index'
import { captureWarnings, publishedValue, settle, storedConfig, stubModel, textResult, useLocalVariables } from './helpers'

const warnings = captureWarnings()

const weather = tool({
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }: { city: string }) => Promise.resolve(`sunny in ${city}`),
})
const time = tool({
  description: 'The current time.',
  inputSchema: z.object({}),
  execute: async () => Promise.resolve('noon'),
})

/** A result carrying one tool call per name, so one response can mix renamed and unrenamed tools. */
function toolCalls(names: string[]): LanguageModelV4GenerateResult {
  return {
    ...textResult(''),
    content: [
      // A part with no tool name at all, which every rewrite has to pass through untouched.
      { type: 'text' as const, text: 'Looking that up.' },
      ...names.map((toolName, index) => ({
        type: 'tool-call' as const,
        toolCallId: `call-${String(index)}`,
        toolName,
        input: toolName === 'get_time' ? '{}' : JSON.stringify({ city: 'Paris' }),
      })),
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  }
}

describe('edges', () => {
  it('patches a tool that describes itself only through its parameters', async () => {
    useLocalVariables(
      publishedValue('agent__undescribed_tool', {
        tool_definitions: [{ name: 'get_weather', parameters: { city: { description: 'A city.' } } }],
      })
    )
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'undescribed_tool', label: 'production' }),
      prompt: 'hi',
      tools: { get_weather: weather },
    })
    await settle()

    const shown = model.doGenerateCalls[0]?.tools?.[0]
    expect(shown).toMatchObject({ name: 'get_weather' })
    expect(shown && 'description' in shown ? shown.description : undefined).toBeUndefined()
    // The baseline says so too: no description in code, so there is none to show -- rather than an
    // empty string standing in for one. The parameter is still listed, with nothing describing it
    // yet, because an undocumented parameter is exactly the one somebody wants to describe from
    // Logfire and a baseline that hid it would need the code changed first.
    const baseline = JSON.parse((await storedConfig('agent__undescribed_tool'))?.example ?? 'null') as {
      tool_definitions: unknown[]
    }
    expect(baseline.tool_definitions).toEqual([{ name: 'get_weather', parameters: { city: {} } }])
  })

  it('renames only the tools an override names, and leaves every other name as it found it', async () => {
    useLocalVariables(
      publishedValue('agent__mixed_renames', {
        tool_definitions: [{ name: 'get_weather', new_name: 'lookup_weather' }],
      })
    )
    const model = stubModel([toolCalls(['lookup_weather', 'get_time', 'made_up']), textResult('done')])
    const result = await generateText({
      model: agentControl({ model, name: 'mixed_renames', label: 'production' }),
      prompt: 'hi',
      stopWhen: stepCountIs(3),
      tools: { get_weather: weather, get_time: time },
    })

    // The renamed tool is mapped back, the untouched one is left alone, and a name this adapter
    // never advertised is passed through for the SDK's own handling of it.
    expect(result.steps[0]?.content.flatMap((part) => ('toolName' in part ? [part.toolName] : [])).sort()).toEqual([
      'get_time',
      'get_time',
      'get_weather',
      'get_weather',
      'made_up',
      'made_up',
    ])

    const history = (model.doGenerateCalls[1]?.prompt ?? []).flatMap((message) =>
      Array.isArray(message.content) ? message.content.flatMap((part) => ('toolName' in part ? [part.toolName] : [])) : []
    )
    expect(history.sort()).toEqual(['get_time', 'get_time', 'lookup_weather', 'lookup_weather', 'made_up', 'made_up'])
  })

  it.each([
    ['provider-default', true, 'reasoning_default'],
    ['none', false, 'reasoning_off'],
    ['high', 'high', 'reasoning_high'],
  ] as const)("publishes reasoning %s as the contract's `thinking` %s", async (reasoning, thinking, name) => {
    useLocalVariables()
    const model = stubModel([textResult('ok')])
    await generateText({ model: agentControl({ model, name }), prompt: 'hi', reasoning })
    await settle()

    const baseline = JSON.parse((await storedConfig(`agent__${name}`))?.example ?? 'null') as {
      settings: { thinking: unknown }
    }
    expect(baseline.settings.thinking).toBe(thinking)
  })

  // Anthropic spells the same knob inverted, so both publish what the agent actually does.
  it.each([
    ['openai.responses', { openai: { parallelToolCalls: false } }, false, 'parallel_baseline_openai'],
    ['anthropic.messages', { anthropic: { disableParallelToolUse: false } }, true, 'parallel_baseline_anthropic'],
  ] as const)(
    "publishes %s's own parallel-tool-calls option as `parallel_tool_calls: %s`",
    async (provider, providerOptions, expected, name) => {
      useLocalVariables()
      const model = stubModel([textResult('ok')], provider, 'a-model')
      await generateText({ model: agentControl({ model, name }), prompt: 'hi', providerOptions })
      await settle()

      const baseline = JSON.parse((await storedConfig(`agent__${name}`))?.example ?? 'null') as {
        settings: { parallel_tool_calls: unknown }
      }
      expect(baseline.settings.parallel_tool_calls).toBe(expected)
    }
  )

  it('keeps the code-defined model when resolving one throws something that is not an `Error`', async () => {
    useLocalVariables(publishedValue('agent__thrown_string', { model: 'acme:big' }))
    const code = stubModel([textResult('from code')])
    const { text } = await generateText({
      model: agentControl({
        model: code,
        name: 'thrown_string',
        label: 'production',
        resolveModel: () => {
          // A provider factory that throws a bare value, which this adapter still has to report
          // rather than let out of a model request.
          // oxlint-disable-next-line typescript/only-throw-error, no-throw-literal
          throw 'acme is not configured'
        },
      }),
      prompt: 'hi',
    })

    expect(text).toBe('from code')
    expect(warnings.messages).toContainEqual(expect.stringContaining('acme is not configured'))
  })

  it('reaches for the AI Gateway when nothing else can resolve a managed model', async () => {
    useLocalVariables(publishedValue('agent__gateway_import', { model: 'anthropic:claude-fable-5-1' }))
    const code = stubModel([textResult('from code')])
    const fetched: string[] = []
    const fetchImpl = globalThis.fetch
    process.env['AI_GATEWAY_API_KEY'] = 'test-key'
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return Promise.reject(new Error('offline'))
    }) as typeof fetch
    try {
      // The real `@ai-sdk/gateway`, imported lazily: it builds a model without a network round trip,
      // and this test never lets one leave the process.
      await expect(
        generateText({
          model: agentControl({ model: code, name: 'gateway_import', label: 'production' }),
          prompt: 'hi',
          maxRetries: 0,
        })
      ).rejects.toThrow(/offline/u)
      expect(code.doGenerateCalls).toEqual([])
      expect(fetched.join(' ')).toContain('ai-gateway.vercel.sh')
      expect(warnings.messages).toContainEqual(expect.stringContaining('in place of the code-defined'))
    } finally {
      globalThis.fetch = fetchImpl
      delete process.env['AI_GATEWAY_API_KEY']
    }
  })

  it('leaves a system message that follows the conversation where the prompt put it', async () => {
    useLocalVariables(publishedValue('agent__mid_prompt_system', { instructions: [{ id: 'system:0' }] }))
    const model = stubModel([textResult('ok')])
    const managed = agentControl({ model, name: 'mid_prompt_system', label: 'production' })

    // Called as a `LanguageModelV4` rather than through `generateText`, because this is a prompt shape
    // the standard helpers do not build: a system message *after* the conversation, which `messages`
    // and `allowSystemInMessages` can carry. Consuming the surviving blocks in order rather than by
    // slot would slide it up in front of the user's turn when the block ahead of it is removed.
    await managed.doGenerate({
      prompt: [
        { role: 'system', content: 'Drop me.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: 'Keep me, here.' },
      ],
    })

    expect(model.doGenerateCalls[0]?.prompt).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: 'Keep me, here.' },
    ])
  })

  it('applies a config to a request nothing in the AI SDK assembled', async () => {
    useLocalVariables(publishedValue('agent__hand_built', { instructions: 'Be brief.' }))
    const model = stubModel([textResult('ok')])
    const managed = agentControl({ model, name: 'hand_built', label: 'production' })

    // The minimum a `LanguageModelV4` call takes: no tools, no tool choice, no settings. `generateText`
    // fills those in, and a middleware that assumed it always had is one a direct caller would break.
    await managed.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be brief.' })
    expect(model.doGenerateCalls[0]?.toolChoice).toBeUndefined()
  })
})
