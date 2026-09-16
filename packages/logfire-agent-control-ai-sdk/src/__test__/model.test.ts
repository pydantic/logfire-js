import type { ProviderV4 } from '@ai-sdk/provider'
import { generateText, streamText } from 'ai'
import { describe, expect, it } from 'vitest'

import { agentControl } from '../index'
import { captureWarnings, publishedValue, stubModel, textResult, textStream, useLocalVariables } from './helpers'

const warnings = captureWarnings()

/** A provider exposing exactly the models a test names, as `createProviderRegistry` takes one. */
function providerOf(models: Record<string, ReturnType<typeof stubModel>>): ProviderV4 {
  return {
    specificationVersion: 'v4',
    languageModel: (modelId: string) => {
      const model = models[modelId]
      if (model === undefined) {
        throw new Error(`no such model '${modelId}'`)
      }
      return model
    },
    embeddingModel: () => {
      throw new Error('not implemented')
    },
    imageModel: () => {
      throw new Error('not implemented')
    },
  } as unknown as ProviderV4
}

describe('model', () => {
  it("resolves a managed 'provider:model' through the registry the caller passed", async () => {
    useLocalVariables(publishedValue('agent__swapped', { model: 'openai:gpt-5.6-sol' }))
    const code = stubModel([textResult('from code')])
    const managed = stubModel([textResult('from managed')], 'openai.responses', 'gpt-5.6-sol')
    const { text } = await generateText({
      model: agentControl({
        model: code,
        name: 'swapped',
        label: 'production',
        providers: { openai: providerOf({ 'gpt-5.6-sol': managed }) },
      }),
      instructions: 'Be brief.',
      prompt: 'hi',
    })

    expect(text).toBe('from managed')
    // The transformed request went to the managed model, and the code model was never called.
    expect(managed.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be brief.' })
    expect(code.doGenerateCalls).toEqual([])
    expect(warnings.messages).toContainEqual(expect.stringContaining('in place of the code-defined'))
  })

  it('swaps the model for a streaming request too', async () => {
    useLocalVariables(publishedValue('agent__swapped_stream', { model: 'openai:gpt-5.6-sol' }))
    const code = stubModel([textStream('from code')])
    const managed = stubModel([textStream('from managed')], 'openai.responses', 'gpt-5.6-sol')
    const stream = streamText({
      model: agentControl({
        model: code,
        name: 'swapped_stream',
        label: 'production',
        providers: { openai: providerOf({ 'gpt-5.6-sol': managed }) },
      }),
      prompt: 'hi',
    })

    expect(await stream.text).toBe('from managed')
    expect(code.doStreamCalls).toEqual([])
  })

  it('prefers a caller-supplied resolver, and resolves each id once', async () => {
    useLocalVariables(publishedValue('agent__custom_resolver', { model: 'acme:big' }))
    const code = stubModel([textResult('one'), textResult('two')])
    const managed = stubModel([textResult('managed'), textResult('managed again')], 'acme.chat', 'big')
    const seen: string[] = []
    const model = agentControl({
      model: code,
      name: 'custom_resolver',
      label: 'production',
      resolveModel: (id) => {
        seen.push(id)
        return managed
      },
    })

    await generateText({ model, prompt: 'hi' })
    await generateText({ model, prompt: 'hi again' })

    expect(managed.doGenerateCalls).toHaveLength(2)
    // Memoized: a provider's model object is meant to be built once and reused.
    expect(seen).toEqual(['acme:big'])
  })

  it('resolves an id once even when two requests reach it at the same time', async () => {
    useLocalVariables(publishedValue('agent__concurrent', { model: 'acme:big' }))
    const code = stubModel([textResult('one'), textResult('two')])
    const managed = stubModel([textResult('managed'), textResult('managed again')], 'acme.chat', 'big')
    const seen: string[] = []
    const model = agentControl({
      model: code,
      name: 'concurrent',
      label: 'production',
      resolveModel: async (id) => {
        seen.push(id)
        // A provider factory that awaits anything -- credentials, a discovery call -- leaves a
        // window in which a second request arrives before the first has an answer to cache.
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })
        return managed
      },
    })

    await Promise.all([generateText({ model, prompt: 'hi' }), generateText({ model, prompt: 'hi again' })])

    expect(managed.doGenerateCalls).toHaveLength(2)
    // One model object for one id, however many requests are in flight when it is first asked for.
    expect(seen).toEqual(['acme:big'])
  })

  it('falls back to the provider a bare string model would have gone through', async () => {
    useLocalVariables(publishedValue('agent__gateway_fallback', { model: 'anthropic:claude-fable-5-1' }))
    const managed = stubModel([textResult('from the gateway')], 'gateway', 'anthropic/claude-fable-5-1')
    const seen: string[] = []
    const previous = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER
    ;(globalThis as { AI_SDK_DEFAULT_PROVIDER?: ProviderV4 }).AI_SDK_DEFAULT_PROVIDER = {
      specificationVersion: 'v4',
      languageModel: (modelId: string) => {
        seen.push(modelId)
        return managed
      },
    } as unknown as ProviderV4
    try {
      const { text } = await generateText({
        model: agentControl({
          model: stubModel([textResult('from code')]),
          name: 'gateway_fallback',
          label: 'production',
        }),
        prompt: 'hi',
      })
      expect(text).toBe('from the gateway')
      // The contract's ':' becomes the gateway's '/', which is the same identifier.
      expect(seen).toEqual(['anthropic/claude-fable-5-1'])
    } finally {
      ;(globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = previous
    }
  })

  it('keeps the code-defined model when a managed string names no provider', async () => {
    useLocalVariables(publishedValue('agent__unqualified', { model: 'gpt-5.6-sol' }))
    const code = stubModel([textResult('from code')])
    const { text } = await generateText({
      model: agentControl({ model: code, name: 'unqualified', label: 'production' }),
      prompt: 'hi',
    })

    expect(text).toBe('from code')
    expect(warnings.messages).toContainEqual(expect.stringContaining("not in 'provider:model' form"))
  })

  it('keeps the code-defined model when a managed string resolves to nothing', async () => {
    useLocalVariables(publishedValue('agent__unresolvable', { model: 'openai:no-such-model' }))
    const code = stubModel([textResult('from code')])
    const { text } = await generateText({
      model: agentControl({
        model: code,
        name: 'unresolvable',
        label: 'production',
        providers: { openai: providerOf({}) },
      }),
      prompt: 'hi',
    })

    expect(text).toBe('from code')
    expect(warnings.messages).toContainEqual(expect.stringContaining('could not be resolved'))
  })

  it('treats a resolver that declines an id as the answer, rather than as a first guess', async () => {
    useLocalVariables(publishedValue('agent__declined', { model: 'anthropic:claude-fable-5-1' }))
    const code = stubModel([textResult('from code')])
    const other = stubModel([textResult('from the registry')], 'anthropic.messages', 'claude-fable-5-1')
    const { text } = await generateText({
      model: agentControl({
        model: code,
        name: 'declined',
        label: 'production',
        resolveModel: () => undefined,
        // Reachable, and deliberately never reached: a resolver that says no is not overruled by the
        // registry behind its back.
        providers: { anthropic: providerOf({ 'claude-fable-5-1': other }) },
      }),
      prompt: 'hi',
    })

    expect(text).toBe('from code')
    expect(other.doGenerateCalls).toEqual([])
    expect(warnings.messages).toContainEqual(expect.stringContaining('declined to build'))
  })

  it('resolves a provider the contract and the AI SDK spell differently', async () => {
    useLocalVariables(publishedValue('agent__vertex', { model: 'google-cloud:gemini-3-pro' }))
    const managed = stubModel([textResult('from vertex')], 'google.vertex.chat', 'gemini-3-pro')
    const { text } = await generateText({
      model: agentControl({
        model: stubModel([textResult('from code')]),
        name: 'vertex',
        label: 'production',
        // The registry is keyed the way `@ai-sdk/google-vertex` exports its provider, which is not
        // the name the contract publishes the same provider under.
        providers: { vertex: providerOf({ 'gemini-3-pro': managed }) },
      }),
      prompt: 'hi',
    })

    expect(text).toBe('from vertex')
  })

  // Pydantic AI v1's names for the two halves of Google. They were removed in v2 in favour of
  // `google` and `google-cloud`, and a config published against a v1-era agent still carries them.
  it.each([
    ['google-gla', 'google', 'legacy_gemini'],
    ['google-vertex', 'vertex', 'legacy_vertex'],
  ])('accepts the legacy name %s as the AI SDK %s', async (legacy, registered, agent) => {
    useLocalVariables(publishedValue(`agent__${agent}`, { model: `${legacy}:gemini-3-pro` }))
    const managed = stubModel([textResult('from the managed model')], 'google.generative-ai', 'gemini-3-pro')
    const { text } = await generateText({
      model: agentControl({
        model: stubModel([textResult('from code')]),
        name: agent,
        label: 'production',
        providers: { [registered]: providerOf({ 'gemini-3-pro': managed }) },
      }),
      prompt: 'hi',
    })

    expect(text).toBe('from the managed model')
  })

  it('lets a registry key answer for a provider name exactly as the caller wrote it', async () => {
    useLocalVariables(publishedValue('agent__vertex_registered', { model: 'google-cloud:gemini-3-pro' }))
    const managed = stubModel([textResult('from vertex')], 'google.vertex.chat', 'gemini-3-pro')
    const { text } = await generateText({
      model: agentControl({
        model: stubModel([textResult('from code')]),
        name: 'vertex_registered',
        label: 'production',
        // Read before the translation table, so a caller who registered the contract's own name gets
        // that provider rather than the one this adapter would have translated the name into.
        providers: { 'google-cloud': providerOf({ 'gemini-3-pro': managed }) },
      }),
      prompt: 'hi',
    })

    expect(text).toBe('from vertex')
  })

  it('reports a provider nothing registered answers to rather than reaching a neighbouring one', async () => {
    useLocalVariables(publishedValue('agent__unknown_provider', { model: 'moonshotai:kimi-k3' }))
    const wrong = stubModel([textResult('from the wrong provider')], 'google.generative-ai', 'gemini-3-pro')
    const { text } = await generateText({
      model: agentControl({
        model: stubModel([textResult('from code')]),
        name: 'unknown_provider',
        label: 'production',
        providers: { google: providerOf({ 'gemini-3-pro': wrong }) },
      }),
      prompt: 'hi',
    })

    // An untranslated name is forwarded as it stands, so a provider package released tomorrow works
    // on the day it lands -- and one nothing serves fails at resolution, under the caller's
    // `onUnmatched` policy, rather than by a different backend answering.
    expect(text).toBe('from code')
    expect(wrong.doGenerateCalls).toEqual([])
    expect(warnings.messages).toContainEqual(expect.stringContaining('could not be resolved'))
  })

  it('fails the run under `error` rather than reporting the refusal a second time', async () => {
    useLocalVariables(publishedValue('agent__strict_model', { model: 'gpt-5.6-sol' }))
    await expect(
      generateText({
        model: agentControl({
          model: stubModel([textResult('from code')]),
          name: 'strict_model',
          label: 'production',
          onUnmatched: 'error',
        }),
        prompt: 'hi',
      })
    ).rejects.toThrow(/not in 'provider:model' form/u)
  })

  it('says nothing when the managed model is the one the code already names', async () => {
    useLocalVariables(publishedValue('agent__same_model', { model: 'anthropic:claude-fable-5-1' }))
    const code = stubModel([textResult('ok')])
    const managed = stubModel([textResult('ok')], 'anthropic.messages', 'claude-fable-5-1')
    await generateText({
      model: agentControl({
        model: code,
        name: 'same_model',
        label: 'production',
        providers: { anthropic: providerOf({ 'claude-fable-5-1': managed }) },
      }),
      prompt: 'hi',
    })

    expect(warnings.messages).not.toContainEqual(expect.stringContaining('in place of the code-defined'))
  })
})
