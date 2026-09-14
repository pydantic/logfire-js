/**
 * Translating model ids between the contract's `provider:model` and Mastra's `provider/model`.
 *
 * The two conventions differ in one character and a handful of provider names, which is exactly the
 * kind of difference that is invisible until a published value silently names nothing. So the
 * translation is explicit in both directions, and a router id whose provider Mastra has never heard
 * of is refused before it reaches a request rather than after.
 */

import { getProviderConfig, parseModelString } from '@mastra/core/llm'

/**
 * Provider ids Pydantic AI v1 used, and what they are called now.
 *
 * Accepted as input and never emitted: a config published against a v1-era agent can still carry
 * them, so they are normalized to the current id before anything else looks at them, and the
 * baseline this adapter publishes only ever names the current one.
 */
const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  'google-gla': 'google',
  'google-vertex': 'google-cloud',
}

/**
 * Provider names that differ between the contract and Mastra's model router.
 *
 * Deliberately short, and checked rather than assumed: the contract's vocabulary is Pydantic AI's,
 * Mastra's is its gateway registry's, and of the ~200 entries in that registry every provider both
 * sides have agrees on the spelling except these three. `openai`, `anthropic`, `google`, `xai`,
 * `groq`, `mistral`, `deepseek`, `cerebras`, `moonshotai`, `huggingface`, `nebius`, `openrouter`,
 * `vercel`, `perplexity`, `crusoe`, `alibaba`, `ovhcloud` and `zai` are the same word on both sides,
 * and a name in neither table passes through untouched so a provider added to Mastra's registry
 * works here on the day it lands.
 *
 * `google-cloud` (Vertex AI) is deliberately absent: Mastra's registry has one `google`, which is the
 * Gemini API, and nothing that serves Vertex. A published `google-cloud:` model is therefore refused
 * and reported rather than quietly sent to the wrong endpoint.
 */
const CANONICAL_TO_MASTRA: Readonly<Record<string, string>> = {
  fireworks: 'fireworks-ai',
  snowflake: 'snowflake-cortex',
  together: 'togetherai',
}

/** The reverse, for the baseline. Every value here is a current id; the legacy aliases are input-only. */
const MASTRA_TO_CANONICAL: Readonly<Record<string, string>> = {
  'fireworks-ai': 'fireworks',
  'snowflake-cortex': 'snowflake',
  togetherai: 'together',
}

/**
 * A published `provider:model` as the router id Mastra resolves, or the string unchanged.
 *
 * Only the first `:` is the separator: a model id may contain more of them (`bedrock:us.anthropic
 * .claude:0`), and everything after the provider belongs to the model. A string with no `:` at all is
 * one this translation cannot classify -- most likely a router id someone wrote in Mastra's own
 * notation -- and is handed to Mastra as it stands rather than rewritten into something else.
 */
export function toRouterModelId(model: string): string {
  const separator = model.indexOf(':')
  if (separator === -1) {
    return model
  }
  const published = model.slice(0, separator)
  const modelId = model.slice(separator + 1)
  const provider = LEGACY_ALIASES[published] ?? published
  return `${CANONICAL_TO_MASTRA[provider] ?? provider}/${modelId}`
}

/**
 * Whether Mastra's model router knows the provider this router id names.
 *
 * Checked before a published model is applied, because Mastra resolves a router id lazily: an
 * unknown provider builds a model object without complaint and fails at the first request instead,
 * which would let one published value take down every run the agent makes. Refusing it here costs a
 * report and keeps the agent on its code-defined model, which is the behavior a remote configuration
 * has to degrade to.
 *
 * The check is against the built-in registry, so a provider reachable only through a custom gateway
 * reads as unknown. That direction is the safe one: a refused model is a warning and a working agent.
 */
export function isRoutableModelId(routerModelId: string): boolean {
  const { provider } = parseModelString(routerModelId)
  // `null` is what Mastra's parser reports for a string that is not `provider/model` at all, which
  // names no provider and so cannot name a registered one.
  return provider !== null && getProviderConfig(provider) !== undefined
}

/**
 * The `provider:model` form of a model the agent is configured with, or `undefined`.
 *
 * Reads the agent's *configured* model rather than resolving it, so the baseline describes what the
 * code says and no dynamic model function is invoked to build a document. Three shapes carry a name:
 * a router id, an AI SDK model instance (`provider`/`modelId`), and neither of those. A function or a
 * fallback list resolves per request into something this cannot name once, and an OpenAI-compatible
 * config names a URL rather than a provider; both come back `undefined`, which leaves `model` out of
 * the baseline entirely rather than pinning one sample of it.
 */
export function toCanonicalModelId(config: unknown): string | undefined {
  if (typeof config === 'string') {
    const { provider, modelId } = parseModelString(config)
    // A string Mastra's parser finds no provider in names a model and nothing else, and the contract
    // has no way to say that, so the baseline leaves `model` out rather than inventing a provider.
    if (provider === null) {
      return undefined
    }
    return `${MASTRA_TO_CANONICAL[provider] ?? provider}:${modelId}`
  }
  if (typeof config !== 'object' || config === null) {
    return undefined
  }
  const model = config as { provider?: unknown; modelId?: unknown }
  if (typeof model.provider !== 'string' || typeof model.modelId !== 'string') {
    return undefined
  }
  const provider = baseProvider(model.provider)
  return `${MASTRA_TO_CANONICAL[provider] ?? provider}:${model.modelId}`
}

/**
 * The provider serving a model, for the settings that only exist as provider options.
 *
 * Takes a router id or a resolved model object, because the model a step runs on is whichever of the
 * two the hook was handed or this adapter is about to hand back.
 */
export function providerOf(config: unknown): string | undefined {
  if (typeof config === 'string') {
    return parseModelString(config).provider ?? undefined
  }
  if (typeof config !== 'object' || config === null) {
    return undefined
  }
  const provider = (config as { provider?: unknown }).provider
  return typeof provider === 'string' ? baseProvider(provider) : undefined
}

/**
 * The provider name an AI SDK model instance really carries.
 *
 * A provider names itself by its API surface -- `anthropic.messages`, `openai.responses`,
 * `google.generative-ai` -- and only the part before the dot is the provider the contract means.
 * Mastra makes the same split when it labels a span with the model that served it.
 */
function baseProvider(provider: string): string {
  const dot = provider.indexOf('.')
  return dot === -1 ? provider : provider.slice(0, dot)
}

/**
 * Whether a model would act on Mastra's `reasoning` setting.
 *
 * Mastra forwards it only to AI SDK v7 (`LanguageModelV4`) providers and drops it for older ones
 * without a word, so a published `thinking` on a v2 or v3 model has to be reported rather than
 * applied. A router id is not resolved here and so cannot be asked, and is given the benefit of the
 * doubt: over-reporting a setting that did apply is its own kind of wrong answer.
 */
export function honorsReasoning(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) {
    return true
  }
  const version = (config as { specificationVersion?: unknown }).specificationVersion
  return version === undefined || version === 'v4'
}
