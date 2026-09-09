import { generateText, ToolLoopAgent, wrapLanguageModel } from 'ai'
import { describe, expect, it } from 'vitest'

import { agentControl, agentControlMiddleware } from '../index'
import { captureWarnings, legacyModel, publishedValue, stubModel, textResult, useLocalVariables } from './helpers'

const warnings = captureWarnings()

describe('settings', () => {
  it('lowers every canonical key onto the AI SDK call option that carries it', async () => {
    useLocalVariables(
      publishedValue('agent__all_settings', {
        settings: {
          max_tokens: 2048,
          temperature: 0.4,
          top_p: 0.9,
          top_k: 40,
          seed: 7,
          presence_penalty: 0.1,
          frequency_penalty: 0.2,
          stop_sequences: ['STOP'],
          thinking: 'high',
        },
      })
    )
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'all_settings', label: 'production' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]).toMatchObject({
      maxOutputTokens: 2048,
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ['STOP'],
      reasoning: 'high',
    })
  })

  it.each([
    [true, 'provider-default', 'thinking_on'],
    [false, 'none', 'thinking_off'],
  ] as const)("maps `thinking: %s` onto the reasoning enum's '%s'", async (thinking, reasoning, name) => {
    useLocalVariables(publishedValue(`agent__${name}`, { settings: { thinking } }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name, label: 'production' }),
      prompt: 'hi',
    })
    expect(model.doGenerateCalls[0]?.reasoning).toBe(reasoning)
  })

  it('turns `timeout` into an abort signal that composes with the run\u2019s own', async () => {
    useLocalVariables(publishedValue('agent__timeout', { settings: { timeout: 30 } }))
    const controller = new AbortController()
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'timeout', label: 'production' }),
      prompt: 'hi',
      abortSignal: controller.signal,
    })

    const signal = model.doGenerateCalls[0]?.abortSignal
    expect(signal?.aborted).toBe(false)
    // Composed rather than replaced: the run's own cancellation still reaches the provider.
    controller.abort()
    expect(signal?.aborted).toBe(true)
  })

  it('arms `timeout` in seconds, on its own when the run passed no signal', async () => {
    // Real timers: `AbortSignal.timeout` is a host timer that a fake clock does not drive.
    useLocalVariables({
      variables: {
        ...publishedValue('agent__timeout_alone', { settings: { timeout: 0.02 } }).variables,
        ...publishedValue('agent__timeout_seconds', { settings: { timeout: 20 } }).variables,
      },
    })
    const quick = stubModel([textResult('ok')])
    const slow = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model: quick, name: 'timeout_alone', label: 'production' }),
      prompt: 'hi',
    })
    await generateText({
      model: agentControl({ model: slow, name: 'timeout_seconds', label: 'production' }),
      prompt: 'hi',
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 60)
    })
    // 0.02s is 20ms and has fired; 20s is not 20ms and has not.
    expect(quick.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true)
    expect(slow.doGenerateCalls[0]?.abortSignal?.aborted).toBe(false)
  })

  it.each([
    ['openai', 'openai.responses', { openai: { parallelToolCalls: false } }],
    ['anthropic', 'anthropic.messages', { anthropic: { disableParallelToolUse: true } }],
  ] as const)("lowers `parallel_tool_calls` through %s's own option", async (namespace, provider, expected) => {
    const name = `parallel_${namespace}`
    useLocalVariables(publishedValue(`agent__${name}`, { settings: { parallel_tool_calls: false } }))
    const model = stubModel([textResult('ok')], provider, 'a-model')
    await generateText({
      model: agentControl({ model, name, label: 'production' }),
      prompt: 'hi',
      providerOptions: { [namespace]: { user: 'someone' } },
    })

    expect(model.doGenerateCalls[0]?.providerOptions).toMatchObject(expected)
    // Whatever the code already set under that provider survives.
    expect(model.doGenerateCalls[0]?.providerOptions?.[namespace]?.['user']).toBe('someone')
  })

  it('reports `parallel_tool_calls` against a provider with no knob for it', async () => {
    useLocalVariables(publishedValue('agent__parallel_other', { settings: { parallel_tool_calls: true } }))
    const model = stubModel([textResult('ok')], 'cohere.chat', 'command')
    await generateText({
      model: agentControl({ model, name: 'parallel_other', label: 'production' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.providerOptions).toBeUndefined()
    expect(warnings.messages).toContainEqual(expect.stringContaining("'parallel_tool_calls'"))
  })

  it('reports a settings key this SDK has no field for', async () => {
    useLocalVariables(publishedValue('agent__unknown_setting', { settings: { logit_bias: { a: 1 } } }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'unknown_setting', label: 'production' }),
      prompt: 'hi',
    })

    expect(warnings.messages).toContainEqual(expect.stringContaining("'logit_bias'"))
  })

  it('lets a per-call value beat the published one, and the published one beat the code', async () => {
    useLocalVariables(publishedValue('agent__precedence', { settings: { temperature: 0.4, max_tokens: 2048 } }))
    const model = stubModel([textResult('one'), textResult('two')])
    // `settings` is what the code declares. A request field that differs from it was set for this
    // run, and this run wins; a field that matches was inherited, and the published value wins.
    const managed = agentControl({
      model,
      name: 'precedence',
      label: 'production',
      codeSettings: { temperature: 0.1, maxOutputTokens: 100 },
    })

    await generateText({ model: managed, prompt: 'hi', temperature: 0.1, maxOutputTokens: 100 })
    expect(model.doGenerateCalls[0]).toMatchObject({ temperature: 0.4, maxOutputTokens: 2048 })

    await generateText({ model: managed, prompt: 'hi', temperature: 0.9, maxOutputTokens: 100 })
    expect(model.doGenerateCalls[1]).toMatchObject({ temperature: 0.9, maxOutputTokens: 2048 })
  })

  it("lets an agent's `prepareCall` override beat the published value", async () => {
    useLocalVariables(publishedValue('agent__prepare_call', { settings: { temperature: 0.4, top_p: 0.5 } }))
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'prepare_call',
          model,
          temperature: 0.1,
          // The agent-level way to set something for one run, which is the only per-run seam a
          // `ToolLoopAgent` call has for generation settings.
          prepareCall: ({ options, ...rest }) => ({ ...rest, options, temperature: 0.9 }),
        },
        label: 'production',
      })
    )

    await agent.generate({ prompt: 'hi' })
    // `topP` was never declared in code, so the published value is all there is.
    expect(model.doGenerateCalls[0]).toMatchObject({ temperature: 0.9, topP: 0.5 })
  })

  it("treats a per-call stop sequence list as this run's own", async () => {
    useLocalVariables(publishedValue('agent__stop_precedence', { settings: { stop_sequences: ['MANAGED'] } }))
    const model = stubModel([textResult('one'), textResult('two'), textResult('three'), textResult('four')])
    const managed = agentControl({
      model,
      name: 'stop_precedence',
      label: 'production',
      codeSettings: { stopSequences: ['CODE'] },
    })

    await generateText({ model: managed, prompt: 'hi', stopSequences: ['CODE'] })
    expect(model.doGenerateCalls[0]?.stopSequences).toEqual(['MANAGED'])

    await generateText({ model: managed, prompt: 'hi', stopSequences: ['RUN'] })
    expect(model.doGenerateCalls[1]?.stopSequences).toEqual(['RUN'])

    // A list of a different length is this run's just as much as a different one of the same length.
    await generateText({ model: managed, prompt: 'hi', stopSequences: ['CODE', 'AND MORE'] })
    expect(model.doGenerateCalls[2]?.stopSequences).toEqual(['CODE', 'AND MORE'])
  })

  it("lets a `prepareCall` beat the published value, and cannot see one that re-sets the code's", async () => {
    useLocalVariables(publishedValue('agent__prepare_call_precedence', { settings: { temperature: 0.8 } }))
    const model = stubModel([textResult('one'), textResult('two')])
    const changed = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'prepare_call_precedence',
          model,
          temperature: 0.2,
          prepareCall: ({ options, ...rest }) => ({ ...rest, options, temperature: 0.5 }),
        },
        label: 'production',
      })
    )
    const restated = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'prepare_call_precedence',
          model,
          temperature: 0.2,
          // The one case this seam cannot see: a hook that asks for the value the code already had is
          // byte for byte a hook that asked for nothing, and `prepareCall` spreads what it did not
          // change, so there is no key set to compare either. Documented as a known limit.
          prepareCall: ({ options, ...rest }) => ({ ...rest, options, temperature: 0.2 }),
        },
        label: 'production',
      })
    )

    await changed.generate({ prompt: 'hi' })
    expect(model.doGenerateCalls[0]?.temperature).toBe(0.5)

    await restated.generate({ prompt: 'hi' })
    expect(model.doGenerateCalls[1]?.temperature).toBe(0.8)
  })

  it('keeps a provider option this run set for itself', async () => {
    useLocalVariables(publishedValue('agent__parallel_precedence', { settings: { parallel_tool_calls: false } }))
    const model = stubModel([textResult('one'), textResult('two')], 'openai.responses', 'gpt-5.6-sol')
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'parallel_precedence',
          model,
          prepareCall: ({ options, ...rest }) => ({
            ...rest,
            options,
            providerOptions: { openai: { parallelToolCalls: true } },
          }),
        },
        label: 'production',
      })
    )
    const inherited = new ToolLoopAgent(agentControl({ settings: { id: 'parallel_precedence', model }, label: 'production' }))

    await agent.generate({ prompt: 'hi' })
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({ openai: { parallelToolCalls: true } })

    await inherited.generate({ prompt: 'hi' })
    expect(model.doGenerateCalls[1]?.providerOptions).toEqual({ openai: { parallelToolCalls: false } })
  })

  it('reports `thinking` against a model whose provider has no reasoning contract', async () => {
    useLocalVariables(publishedValue('agent__legacy_thinking', { settings: { thinking: 'high', temperature: 0.3 } }))
    const model = legacyModel('v3')
    await generateText({
      model: agentControl({ model, name: 'legacy_thinking', label: 'production' }),
      prompt: 'hi',
    })

    // `reasoning` is the one call option v4 added; `wrapLanguageModel` bridges an older model with a
    // proxy that answers 'v4' and forwards, so applying it here would change nothing at all.
    expect(model.calls[0]?.reasoning).toBeUndefined()
    expect(model.calls[0]?.temperature).toBe(0.3)
    expect(warnings.messages).toContainEqual(expect.stringContaining("'thinking'"))
  })

  it('assumes a v4 model when a hand-rolled middleware install does not say otherwise', async () => {
    useLocalVariables(publishedValue('agent__assumed_v4', { settings: { thinking: 'high' } }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: wrapLanguageModel({
        model,
        middleware: agentControlMiddleware({ name: 'assumed_v4', label: 'production' }),
      }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.reasoning).toBe('high')
  })

  it('arms a `timeout` too small to round to a whole millisecond', async () => {
    useLocalVariables(publishedValue('agent__tiny_timeout', { settings: { timeout: 0.0005 } }))
    const model = stubModel([textResult('ok')])
    // Half a millisecond is not a delay `AbortSignal.timeout` accepts; the core rounds a positive
    // budget up to 1ms rather than letting it throw before the request is made.
    await generateText({
      model: agentControl({ model, name: 'tiny_timeout', label: 'production' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.abortSignal).toBeDefined()
  })

  it('drops a `timeout` no request could be given, and says so', async () => {
    useLocalVariables(publishedValue('agent__bad_timeout', { settings: { timeout: -1 } }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'bad_timeout', label: 'production' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.abortSignal).toBeUndefined()
    expect(warnings.messages).toContainEqual(expect.stringContaining('not a budget a request can be given'))
  })

  it('publishes nothing under `settings` when the request carries none', async () => {
    useLocalVariables(publishedValue('agent__no_settings', {}))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'no_settings', label: 'production' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.temperature).toBeUndefined()
  })
})
