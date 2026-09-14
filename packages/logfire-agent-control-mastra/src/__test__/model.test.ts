import { Agent } from '@mastra/core/agent'
import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import { isRoutableModelId, toCanonicalModelId, toRouterModelId } from '../model'
import { captureWarnings, mockModel, nextAgentId, run, useManagedAgent } from './helpers'

const warnings = captureWarnings()

function agentWith(id: string, model = mockModel('mock', 'code-model')): Agent {
  return new Agent({ id, name: 'A', instructions: 'x', model, inputProcessors: [agentControl()] })
}

describe('the model section', () => {
  it('sends the request to the published model instead of the code-defined one', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { model: 'openai:gpt-5.6-sol' })
    const code = mockModel('mock', 'code-model')

    // Offline, and that is the assertion: the run reaches OpenAI's router entry and stops for want of
    // a key, which is only possible if the published model replaced the code-defined one.
    await expect(run(agentWith(id, code))).rejects.toThrow(/OPENAI_API_KEY.*openai\/gpt-5\.6-sol/u)
    expect(code.doGenerateCalls).toHaveLength(0)
  })

  it("translates the contract's provider names into Mastra's", async () => {
    const id = nextAgentId()
    useManagedAgent(id, { model: 'together:moonshotai/Kimi-K2-Thinking' })

    // The contract calls it `together` and Mastra's registry calls it `togetherai`; the error names
    // the router id the translation produced.
    await expect(run(agentWith(id))).rejects.toThrow(/togetherai\/moonshotai\/Kimi-K2-Thinking/u)
  })

  it('accepts the provider ids Pydantic AI v1 used', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { model: 'google-gla:gemini-2.5-flash-lite' })

    // `google-gla` was v1's name for the Gemini API and is `google` now, but a config published
    // against a v1-era agent can still carry it, so it is normalized rather than refused.
    await expect(run(agentWith(id))).rejects.toThrow(/google\/gemini-2\.5-flash-lite/u)
  })

  it('keeps the code-defined model when the published provider is not one Mastra can route', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { model: 'bedrock:claude-fable-5-1' })
    const code = mockModel('mock', 'code-model')

    // Mastra would build a model object for an unknown provider and fail at every request, so a
    // provider its router does not know is refused here and reported, and the agent keeps running.
    expect(await run(agentWith(id, code))).toBe('ok')
    expect(warnings.messages).toEqual([
      expect.stringContaining("selects model 'bedrock:claude-fable-5-1', whose provider is not one Mastra's model router knows"),
    ])
  })

  it('keeps the code-defined model for Vertex AI, which Mastra has no provider for', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { model: 'google-cloud:gemini-2.5-flash-lite' })
    const code = mockModel('mock', 'code-model')

    // Mastra's registry has one `google`, and it is the Gemini API. Mapping Vertex onto it would send
    // the request to a different service than the one the published value named.
    expect(await run(agentWith(id, code))).toBe('ok')
    expect(warnings.messages).toEqual([
      expect.stringContaining("selects model 'google-cloud:gemini-2.5-flash-lite', whose provider is not one Mastra's model router knows"),
    ])
  })
})

describe('model id translation', () => {
  it('swaps the separator and maps the provider names that differ', () => {
    expect(toRouterModelId('anthropic:claude-fable-5-1')).toBe('anthropic/claude-fable-5-1')
    // The three providers both sides have under different names.
    expect(toRouterModelId('together:zai-org/GLM-4.6')).toBe('togetherai/zai-org/GLM-4.6')
    expect(toRouterModelId('fireworks:kimi-k2-instruct')).toBe('fireworks-ai/kimi-k2-instruct')
    expect(toRouterModelId('snowflake:claude-sonnet-4-5')).toBe('snowflake-cortex/claude-sonnet-4-5')
    // Only the first colon separates: the rest belongs to the model id.
    expect(toRouterModelId('bedrock:us.anthropic.claude:0')).toBe('bedrock/us.anthropic.claude:0')
    // A string with no provider separator is one this cannot classify, and is left as it stands --
    // most likely someone wrote Mastra's own notation into the config.
    expect(toRouterModelId('openai/gpt-5.6-sol')).toBe('openai/gpt-5.6-sol')
  })

  it("normalizes Pydantic AI v1's provider ids to the current ones", () => {
    expect(toRouterModelId('google-gla:gemini-2.5-flash')).toBe('google/gemini-2.5-flash')
    expect(toRouterModelId('google:gemini-2.5-flash')).toBe('google/gemini-2.5-flash')
    // Both spellings of Vertex land on the same unroutable id, so both are refused the same way
    // rather than one of them reaching Mastra's Gemini API entry.
    expect(toRouterModelId('google-vertex:gemini-2.5-flash')).toBe('google-cloud/gemini-2.5-flash')
    expect(toRouterModelId('google-cloud:gemini-2.5-flash')).toBe('google-cloud/gemini-2.5-flash')
  })

  it('knows which providers Mastra can route', () => {
    expect(isRoutableModelId('openai/gpt-5.6-sol')).toBe(true)
    expect(isRoutableModelId('google/gemini-2.5-flash')).toBe(true)
    expect(isRoutableModelId('google-cloud/gemini-2.5-flash')).toBe(false)
    expect(isRoutableModelId('bedrock/claude')).toBe(false)
    expect(isRoutableModelId('gpt-5.6-sol')).toBe(false)
  })

  it('names a configured model the way the contract does, or not at all', () => {
    expect(toCanonicalModelId('anthropic/claude-fable-5-1')).toBe('anthropic:claude-fable-5-1')
    // The baseline emits the current ids only, never the v1 aliases the input side still accepts.
    expect(toCanonicalModelId('google/gemini-2.5-flash')).toBe('google:gemini-2.5-flash')
    expect(toCanonicalModelId('togetherai/zai-org/GLM-4.6')).toBe('together:zai-org/GLM-4.6')
    // An AI SDK provider names its API surface; only the part before the dot is the provider.
    expect(toCanonicalModelId({ provider: 'openai.responses', modelId: 'gpt-5.6-sol' })).toBe('openai:gpt-5.6-sol')
    expect(toCanonicalModelId({ provider: 'openai', modelId: 'gpt-5.6-sol' })).toBe('openai:gpt-5.6-sol')
    // Nothing here names a provider: a bare model id, an OpenAI-compatible endpoint config, a
    // callable, a fallback list. The baseline leaves `model` out rather than inventing one.
    expect(toCanonicalModelId('gpt-5.6-sol')).toBeUndefined()
    expect(toCanonicalModelId({ id: 'gpt-5.6-sol', url: 'https://example.test' })).toBeUndefined()
    expect(toCanonicalModelId(() => 'openai/gpt-5.6-sol')).toBeUndefined()
    expect(toCanonicalModelId(undefined)).toBeUndefined()
  })
})
