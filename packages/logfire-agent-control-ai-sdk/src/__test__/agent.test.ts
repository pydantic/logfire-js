import { generateText, ToolLoopAgent } from 'ai'
import { describe, expect, it } from 'vitest'

import { agentControl, agentControlMiddleware } from '../index'
import { captureWarnings, publishedValue, stubModel, textResult, useLocalVariables } from './helpers'

captureWarnings()

describe('agentControl', () => {
  it('fills in the agent id and the telemetry function id from the name', () => {
    const settings = agentControl({
      settings: { model: stubModel([]), temperature: 0.2 },
      name: 'checkout_assistant',
    })

    expect(settings.id).toBe('checkout_assistant')
    expect(settings.telemetry.functionId).toBe('checkout_assistant')
    // Everything else is carried over untouched.
    expect(settings.temperature).toBe(0.2)
  })

  it("takes the agent's own id as the name, and leaves an explicit function id alone", () => {
    const settings = agentControl({
      settings: {
        id: 'from_id',
        model: stubModel([]),
        telemetry: { functionId: 'already_traced' },
      },
    })

    expect(settings.id).toBe('from_id')
    expect(settings.telemetry.functionId).toBe('already_traced')
  })

  it('falls back to the telemetry function id when there is no agent id', () => {
    const settings = agentControl({ settings: { model: stubModel([]), telemetry: { functionId: 'from_telemetry' } } })

    expect(settings.id).toBe('from_telemetry')
  })

  it('refuses an agent with no name at all', () => {
    expect(() => agentControl({ settings: { model: stubModel([]) } })).toThrow(/needs an explicit agent name/u)
    expect(() => agentControl({ settings: { id: '  ', model: stubModel([]) } })).toThrow(/needs an explicit agent name/u)
  })

  it('refuses a model it cannot wrap', () => {
    expect(() => agentControl({ settings: { id: 'string_model', model: 'anthropic/claude-fable-5-1' } })).toThrow(
      /cannot manage the string model/u
    )
  })

  it('refuses a middleware with no name', () => {
    expect(() => agentControlMiddleware({})).toThrow(/needs an explicit agent name/u)
    expect(() => agentControl({ model: stubModel([]), name: '' })).toThrow(/needs an explicit agent name/u)
  })

  it('manages an agent built from the settings it returns', async () => {
    useLocalVariables(
      publishedValue('agent__end_to_end', {
        instructions: [{ id: 'system:0', instructions: 'Be terse.' }],
        settings: { temperature: 0.9 },
      })
    )
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: { id: 'end_to_end', model, instructions: 'Be brief.', temperature: 0.1 },
        label: 'production',
      })
    )

    const { text } = await agent.generate({ prompt: 'hi' })
    expect(text).toBe('ok')
    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be terse.' })
    expect(model.doGenerateCalls[0]?.temperature).toBe(0.9)
  })

  it("accepts one system message as an agent's instructions", async () => {
    useLocalVariables(publishedValue('agent__single_message', { instructions: [{ id: 'greeting', instructions: 'Managed.' }] }))
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'single_message',
          model,
          instructions: { role: 'system', content: 'Code.', providerOptions: { logfire: { id: 'greeting' } } },
        },
        label: 'production',
      })
    )

    await agent.generate({ prompt: 'hi' })
    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({ content: 'Managed.' })
  })

  it("leaves an agent's own `prepareCall` in place", async () => {
    useLocalVariables(publishedValue('agent__own_prepare_call', { settings: { temperature: 0.4 } }))
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'own_prepare_call',
          model,
          instructions: 'Be brief.',
          prepareCall: ({ options, ...rest }) => ({ ...rest, options, instructions: 'Prepared.' }),
        },
        label: 'production',
      })
    )

    await agent.generate({ prompt: 'hi' })
    // The hook ran and its instructions reached the model, and nothing was added to the request in
    // passing: this helper wraps the model, not the agent's own hooks.
    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Prepared.' })
    expect(model.doGenerateCalls[0]?.providerOptions).toBeUndefined()
    // Nothing the hook changed was a generation setting, so the published one still applies.
    expect(model.doGenerateCalls[0]?.temperature).toBe(0.4)
  })

  it('applies nothing when the published config says to change nothing', async () => {
    useLocalVariables(publishedValue('agent__empty_config', {}))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'empty_config', label: 'production' }),
      instructions: 'Be brief.',
      prompt: 'hi',
      temperature: 0.3,
    })

    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be brief.' })
    expect(model.doGenerateCalls[0]?.temperature).toBe(0.3)
  })
})
