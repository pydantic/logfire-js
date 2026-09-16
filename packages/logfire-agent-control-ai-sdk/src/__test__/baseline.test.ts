import { generateText, ToolLoopAgent, tool } from 'ai'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { AGENT_CONFIG_JSON_SCHEMA } from '@pydantic/logfire-node/agent-control'

import { agentControl } from '../index'
import { captureWarnings, legacyModel, publishedValue, settle, storedConfig, stubModel, textResult, useLocalVariables } from './helpers'

captureWarnings()

const weather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string().describe('City name, e.g. `London`.') }),
  execute: async ({ city }: { city: string }) => Promise.resolve(`sunny in ${city}`),
})

/** The `example` a variable ended up with, parsed. */
async function baselineOf(variableName: string): Promise<Record<string, unknown>> {
  return JSON.parse((await storedConfig(variableName))?.example ?? 'null') as Record<string, unknown>
}

describe('baseline', () => {
  it('publishes the agent as written, from the first request', async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'checkout_assistant',
          model,
          instructions: [
            { role: 'system', content: 'You are a concise checkout assistant.' },
            {
              role: 'system',
              content: 'Always confirm the order total.',
              providerOptions: { logfire: { id: 'refunds' } },
            },
          ],
          temperature: 0.1,
          maxOutputTokens: 1024,
          tools: { get_weather: weather },
        },
      })
    )

    await agent.generate({ prompt: 'hi' })
    await settle()

    const stored = await storedConfig('agent__checkout_assistant')
    expect(JSON.parse(stored?.example ?? 'null')).toMatchInlineSnapshot(`
      {
        "instructions": [
          {
            "dynamic": false,
            "id": "system:0",
            "instructions": "You are a concise checkout assistant.",
          },
          {
            "dynamic": false,
            "id": "refunds",
            "instructions": "Always confirm the order total.",
          },
        ],
        "model": "anthropic:claude-fable-5-1",
        "settings": {
          "max_tokens": 1024,
          "temperature": 0.1,
        },
        "tool_definitions": [
          {
            "description": "Get the current weather for a city.",
            "name": "get_weather",
            "parameters": {
              "city": {
                "description": "City name, e.g. \`London\`.",
              },
            },
          },
        ],
      }
    `)
    // The agent said what it is, so the baseline describes the code rather than one request.
    expect(stored?.description).toContain('the agent as written')
    // The stored schema is what makes the variable editable in the Logfire UI at all: the backend
    // validates every value written against it.
    expect(stored?.json_schema).toEqual(AGENT_CONFIG_JSON_SCHEMA)
  })

  it('publishes a block a hook injected as a seam, with neither its text nor a claim about it', async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok'), textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'tenant_agent',
          model,
          instructions: 'You are a concise assistant.',
          prepareStep: () => ({
            instructions: [
              { role: 'system' as const, content: 'You are a concise assistant.' },
              { role: 'system' as const, content: `Tenant: acme-${String(Date.now())}` },
            ],
          }),
        },
      })
    )

    // The first request is what the baseline is sampled from, and the agent's declared instructions
    // are known before it, so even that one classifies the injected block correctly.
    await agent.generate({ prompt: 'hi' })
    await settle()

    expect((await baselineOf('agent__tenant_agent'))['instructions']).toEqual([
      { id: 'system:0', instructions: 'You are a concise assistant.', dynamic: false },
      { id: 'system:1', dynamic: true },
    ])
  })

  it('publishes only seams, and says it is observing, when the agent declared nothing', async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'bare_middleware' }),
      instructions: 'Be brief.',
      prompt: 'hi',
      temperature: 0.5,
    })
    await settle()

    const stored = await storedConfig('agent__bare_middleware')
    // Nothing here is provably the agent's own: a bare model install cannot see a line of its code.
    // So the block is a seam without its text, and the editor is told the example is one request's.
    expect(JSON.parse(stored?.example ?? 'null')).toEqual({
      instructions: [{ id: 'system:0', dynamic: true }],
      model: 'anthropic:claude-fable-5-1',
      settings: { temperature: 0.5 },
    })
    expect(stored?.description).toContain('snapshotted from one request')
  })

  it('publishes a block whose text the code declares, even installed on a bare model', async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({
        model,
        name: 'declared_on_a_model',
        codeInstructions: 'Be brief.',
        codeSettings: { temperature: 0.1 },
      }),
      instructions: 'Be brief.',
      prompt: 'hi',
      temperature: 0.5,
    })
    await settle()

    const stored = await storedConfig('agent__declared_on_a_model')
    // The declared text matched, so it is publishable -- and `temperature` comes from what the code
    // declared rather than from the value this one run happened to pass.
    expect(JSON.parse(stored?.example ?? 'null')).toEqual({
      instructions: [{ id: 'system:0', instructions: 'Be brief.', dynamic: false }],
      model: 'anthropic:claude-fable-5-1',
      settings: { temperature: 0.1 },
    })
    expect(stored?.description).toContain('the agent as written')
  })

  it("publishes the agent's declared settings rather than the first run's", async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'declared_settings',
          model,
          instructions: 'Be brief.',
          temperature: 0.1,
          // One run asking for something else must not become the published code default.
          prepareCall: ({ options, ...rest }) => ({ ...rest, options, temperature: 0.9 }),
        },
      })
    )

    await agent.generate({ prompt: 'hi' })
    await settle()

    expect((await baselineOf('agent__declared_settings'))['settings']).toEqual({ temperature: 0.1 })
    expect(model.doGenerateCalls[0]?.temperature).toBe(0.9)
  })

  it('leaves `thinking` out for a model whose provider has no reasoning contract', async () => {
    useLocalVariables()
    const model = legacyModel('v3')
    await generateText({
      model: agentControl({ model, name: 'legacy_baseline' }),
      prompt: 'hi',
      reasoning: 'high',
    })
    await settle()

    // The request carries `reasoning`, because the AI SDK builds v4 call options for every model --
    // but this provider drops it, so publishing it would offer an edit that changes nothing.
    expect(model.calls[0]?.reasoning).toBe('high')
    expect(await baselineOf('agent__legacy_baseline')).toEqual({ model: 'legacy:old-model' })
  })

  it('publishes once per process, even across runs', async () => {
    useLocalVariables()
    const model = stubModel([textResult('one'), textResult('two')])
    const managed = agentControl({ model, name: 'published_once', codeInstructions: 'First.', codeSettings: {} })
    await generateText({ model: managed, instructions: 'First.', prompt: 'hi' })
    await settle()
    await generateText({ model: managed, instructions: 'Second.', prompt: 'hi' })
    await settle()

    const stored = await storedConfig('agent__published_once')
    expect(stored?.example).toContain('First.')
  })

  it('does not publish when the caller asked it not to', async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'no_publish', publishBaseline: false }),
      instructions: 'Be brief.',
      prompt: 'hi',
    })
    await settle()
    expect(await storedConfig('agent__no_publish')).toBeUndefined()
  })

  it('reports the gateway form of a model under the provider it names', async () => {
    useLocalVariables()
    const model = stubModel([textResult('ok')], 'gateway', 'anthropic/claude-fable-5.1')
    await generateText({ model: agentControl({ model, name: 'gateway_model' }), prompt: 'hi' })
    await settle()

    expect(await baselineOf('agent__gateway_model')).toEqual({ model: 'anthropic:claude-fable-5.1' })
  })

  // Google is one AI SDK namespace and two contract providers, so a baseline that went by the
  // namespace alone would publish a Vertex model under the Gemini API's name and offer the editor an
  // override that reaches a different backend.
  it.each([
    ['google.generative-ai', 'google:gemini-3-pro', 'gemini_api_model'],
    ['google.vertex.chat', 'google-cloud:gemini-3-pro', 'vertex_model'],
  ])("names a %s model '%s' in the baseline", async (provider, identifier, agent) => {
    useLocalVariables()
    const model = stubModel([textResult('ok')], provider, 'gemini-3-pro')
    await generateText({ model: agentControl({ model, name: agent }), prompt: 'hi' })
    await settle()

    expect(await baselineOf(`agent__${agent}`)).toEqual({ model: identifier })
  })

  it('publishes the agent as written even when a config is already applying', async () => {
    useLocalVariables(publishedValue('agent__already_managed', { instructions: [{ id: 'system:0', instructions: 'Be terse.' }] }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'already_managed', label: 'production', codeInstructions: 'Be brief.' }),
      instructions: 'Be brief.',
      prompt: 'hi',
    })
    await settle()

    const stored = await storedConfig('agent__already_managed')
    expect(stored?.example).toContain('Be brief.')
    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be terse.' })
  })
})
