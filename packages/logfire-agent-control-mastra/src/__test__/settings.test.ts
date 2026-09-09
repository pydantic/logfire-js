import { Agent } from '@mastra/core/agent'
import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import { lowerSettings, raiseSettings } from '../settings'
import { callAt, captureWarnings, mockModel, mockModelV4, nextAgentId, run, useManagedAgent } from './helpers'

const warnings = captureWarnings()

/** Lower one published patch against one step's settings, with everything else held still. */
function lower(
  settings: Parameters<typeof lowerSettings>[0],
  effective: Record<string, unknown> | undefined,
  defaults: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return lowerSettings(settings, {
    provider: 'openai',
    supportsReasoning: true,
    modelSettings: { effective, defaults },
    providerOptions: { effective: undefined, defaults: undefined },
  }).modelSettings
}

describe('the settings section', () => {
  it('lowers every canonical setting onto the call Mastra makes', async () => {
    const id = nextAgentId()
    useManagedAgent(id, {
      settings: {
        max_tokens: 2048,
        temperature: 0.4,
        top_p: 0.9,
        top_k: 40,
        seed: 7,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        stop_sequences: ['END'],
      },
    })
    const model = mockModel()
    const agent = new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })

    await run(agent)

    expect(callAt(model, 0)).toMatchObject({
      maxOutputTokens: 2048,
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ['END'],
    })
  })

  it('keeps the settings the agent already had that the published value says nothing about', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { temperature: 0.9 } })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model,
      // Mastra replaces the step's whole settings object with whatever a processor returns, so the
      // agent's own `maxOutputTokens` has to survive a published `temperature`.
      defaultOptions: { modelSettings: { temperature: 0.2, maxOutputTokens: 100 } },
      inputProcessors: [agentControl()],
    })

    await run(agent)

    expect(callAt(model, 0)).toMatchObject({ temperature: 0.9, maxOutputTokens: 100 })
  })

  it('lets a value the caller passed for this run beat the published one', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { temperature: 0.9 } })
    const model = mockModel()
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model,
      defaultOptions: { modelSettings: { temperature: 0.2 } },
      inputProcessors: [agentControl()],
    })

    await agent.generate('hi', { modelSettings: { temperature: 0.5 } })

    // Per-run beats published beats code. Mastra merges the call's settings into the agent's defaults
    // before any processor runs, so "the caller set this" is recovered by diffing against them.
    expect(callAt(model, 0)).toMatchObject({ temperature: 0.5 })
  })

  it('enforces a published timeout as the per-step budget it is', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { timeout: 0.01 } })
    const model = mockModel()
    model.doGenerate = async () =>
      new Promise<never>(() => {
        // Never settles, so the step budget is the only thing that can end this call.
      })
    const agent = new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })

    // The contract's `timeout` is seconds and is per model request, which is Mastra's `stepMs`. It
    // never reaches the provider call, so the only honest proof is that it stops one.
    await expect(run(agent)).rejects.toThrow(/timed out|timeout/iu)
  })

  it('lowers `thinking` onto the reasoning level of a model that acts on it', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { thinking: 'high' } })
    const model = mockModelV4()
    const agent = new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })

    await run(agent)

    expect(model.doGenerateCalls[0]).toMatchObject({ reasoning: 'high' })
  })

  it('reports `thinking` where Mastra would drop it, rather than letting it look applied', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { thinking: true } })
    const model = mockModel()
    const agent = new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })

    await run(agent)

    // Mastra forwards `reasoning` only to AI SDK v7 providers and silently drops it for older ones.
    expect(callAt(model, 0)).not.toHaveProperty('reasoning')
    expect(warnings.messages).toEqual([expect.stringContaining("sets 'thinking', which this agent framework has no model setting for")])
  })

  it('lowers `parallel_tool_calls` onto the provider option each provider gives it', async () => {
    const openaiId = nextAgentId()
    useManagedAgent(openaiId, { settings: { parallel_tool_calls: false } })
    const openai = mockModel('openai.responses', 'gpt-5.6-sol')
    await run(new Agent({ id: openaiId, name: 'A', instructions: 'x', model: openai, inputProcessors: [agentControl()] }))
    expect(callAt(openai, 0).providerOptions).toEqual({ openai: { parallelToolCalls: false } })

    const anthropicId = nextAgentId()
    useManagedAgent(anthropicId, { settings: { parallel_tool_calls: false } })
    const anthropic = mockModel('anthropic.messages', 'claude-fable-5-1')
    await run(new Agent({ id: anthropicId, name: 'A', instructions: 'x', model: anthropic, inputProcessors: [agentControl()] }))
    // Anthropic asks the opposite question, so the value is inverted rather than copied.
    expect(callAt(anthropic, 0).providerOptions).toEqual({ anthropic: { disableParallelToolUse: true } })
  })

  it('leaves a provider option this run set for itself alone', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { parallel_tool_calls: false } })
    const model = mockModel('openai.responses', 'gpt-5.6-sol')
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model,
      defaultOptions: { providerOptions: { openai: { parallelToolCalls: false } } },
      inputProcessors: [agentControl()],
    })

    await agent.generate('hi', { providerOptions: { openai: { parallelToolCalls: true } } })

    // The published value and the agent's default agree, and the run disagrees with both: per-run
    // beats published, in provider options as much as in model settings.
    expect(callAt(model, 0).providerOptions).toEqual({ openai: { parallelToolCalls: true } })
  })

  it('keeps a provider option the agent set alongside the one it publishes', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { parallel_tool_calls: true } })
    const model = mockModel('openai.responses', 'gpt-5.6-sol')
    const agent = new Agent({
      id,
      name: 'A',
      instructions: 'x',
      model,
      defaultOptions: { providerOptions: { openai: { serviceTier: 'flex' } } },
      inputProcessors: [agentControl()],
    })

    await run(agent)

    expect(callAt(model, 0).providerOptions).toEqual({ openai: { serviceTier: 'flex', parallelToolCalls: true } })
  })

  it('reports `parallel_tool_calls` for a provider that has nowhere to put it', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { parallel_tool_calls: true } })
    const model = mockModel('cerebras', 'llama')
    const agent = new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })

    await run(agent)

    expect(warnings.messages).toEqual([
      expect.stringContaining("sets 'parallel_tool_calls', which this agent framework has no model setting for"),
    ])
  })

  it('reports a settings key this SDK has no field for', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { settings: { temperature: 0.4, reasoning_budget: 1024 } })
    const model = mockModel()
    const agent = new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })

    await run(agent)

    expect(callAt(model, 0)).toMatchObject({ temperature: 0.4 })
    expect(warnings.messages).toEqual([
      expect.stringContaining("sets 'reasoning_budget', which this version of the SDK has no model setting for"),
    ])
  })
})

describe('raising Mastra settings back to the contract', () => {
  it('reverses every lowering, units included', () => {
    expect(
      raiseSettings(
        {
          maxOutputTokens: 100,
          temperature: 0.2,
          topP: 0.9,
          topK: 40,
          seed: 7,
          presencePenalty: 0.1,
          frequencyPenalty: 0.2,
          stopSequences: ['END'],
          timeout: { stepMs: 30_000, totalMs: 120_000 },
          reasoning: 'high',
        },
        { anthropic: { disableParallelToolUse: true } },
        'anthropic'
      )
    ).toEqual({
      max_tokens: 100,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      seed: 7,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      stop_sequences: ['END'],
      timeout: 30,
      thinking: 'high',
      parallel_tool_calls: false,
    })
  })

  it('reads the two reasoning levels that stand for a boolean, and describes nothing it cannot', () => {
    expect(raiseSettings({ reasoning: 'provider-default' }, undefined, undefined)).toEqual({ thinking: true })
    expect(raiseSettings({ reasoning: 'none' }, undefined, undefined)).toEqual({ thinking: false })
    // A run-wide budget is not the contract's per-request `timeout`, and a level this SDK does not
    // know is not one it can name.
    expect(raiseSettings({ timeout: { totalMs: 1000 }, reasoning: 'exhaustive' }, undefined, undefined)).toEqual({})
    expect(raiseSettings(undefined, undefined, undefined)).toEqual({})
  })

  it('reads `parallel_tool_calls` from the provider serving the agent, and no other', () => {
    const options = { openai: { parallelToolCalls: false } }

    expect(raiseSettings(undefined, options, 'openai')).toEqual({ parallel_tool_calls: false })
    // An agent may carry options for a provider it is not running on. Describing one as this agent's
    // setting would make a publish of the baseline apply it -- inverted -- to the provider it is.
    expect(raiseSettings(undefined, options, 'anthropic')).toEqual({})
    expect(raiseSettings(undefined, options, 'groq')).toEqual({})
  })
})

describe('telling a value this run chose from a code default', () => {
  it('leaves a value that differs from the agent default standing, and overwrites one that does not', () => {
    // Nothing to return: the step already carries the value this run chose, so the published one is
    // simply not applied.
    expect(lower({ temperature: 0.9 }, { temperature: 0.5 }, { temperature: 0.2 })).toBeUndefined()
    // A key the agent has no default for and the step does carry is one this run set, too.
    expect(lower({ seed: 1 }, { seed: 7 }, undefined)).toBeUndefined()
    expect(lower({ temperature: 0.9 }, { temperature: 0.2 }, { temperature: 0.2 })).toMatchObject({
      temperature: 0.9,
    })
  })

  it('compares structural values by value, not by reference', () => {
    // A fresh but identical `stopSequences` array is the agent's own default, not something this call
    // asked for, so the published value wins it.
    expect(lower({ stop_sequences: ['DONE'] }, { stopSequences: ['END'] }, { stopSequences: ['END'] })).toMatchObject({
      stopSequences: ['DONE'],
    })
  })

  it('merges a published step budget into a run-wide one rather than replacing it', () => {
    // `totalMs` is a deadline for the whole run and the contract has no way to say it, so a published
    // per-request budget has to leave the one in code standing.
    const budget = { timeout: { totalMs: 120_000 } }
    expect(lower({ timeout: 30 }, budget, budget)).toMatchObject({
      timeout: { stepMs: 30_000, totalMs: 120_000 },
    })
  })
})
