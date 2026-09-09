/**
 * The managed `model` string, in both directions.
 *
 * The contract's model is `'provider:model'` -- which is, as it happens, exactly what
 * `createProviderRegistry` resolves, `':'` being its default separator. So a user who has a registry
 * needs no translation at all, and one who has not gets the AI Gateway's `'provider/model'` form,
 * which is the same identifier with the separator the gateway spells it with.
 *
 * The provider *names* need one more step. The contract's vocabulary is Pydantic AI's, and it agrees
 * with the AI SDK's on every provider but Vertex AI, which the two spell differently while splitting
 * Google the same way; forwarding those names unchanged is how a published value reaches a registry
 * that has never heard of it, or a gateway that has heard of it and means something else by it.
 */

import type { LanguageModelV2, LanguageModelV3, LanguageModelV4, ProviderV3, ProviderV4 } from '@ai-sdk/provider'
import type { ProviderRegistryProvider } from 'ai'
import { createProviderRegistry } from 'ai'

/** The id form `createProviderRegistry` accepts, and the contract's `provider:model`. */
type QualifiedModelId = `${string}:${string}`

/**
 * A model as it is written in code, before `wrapLanguageModel` bridges it to `LanguageModelV4`.
 *
 * All three are accepted, because `wrapLanguageModel` accepts all three -- but the bridge it builds
 * for the older two is a `Proxy` whose only behavior is to answer `'v4'` to `specificationVersion`
 * (`ai/src/model/as-language-model-v4.ts`), so what a middleware is handed cannot be asked which one
 * it really is. See `specificationVersionOf`.
 */
export type WrappableModel = LanguageModelV2 | LanguageModelV3 | LanguageModelV4

/** A model specification version, as a model reports it before it is bridged. */
export type SpecificationVersion = 'v2' | 'v3' | 'v4'

/**
 * Provider names the contract and the AI SDK ecosystem spell differently.
 *
 * The contract's vocabulary is Pydantic AI's, the AI SDK's is its provider packages' and the
 * gateway's, and the two agree on every name -- `anthropic`, `openai`, `xai`, `groq`, `mistral`,
 * `deepseek`, `cohere`, and `google` for the Gemini API -- except for Vertex AI, which the contract
 * calls `google-cloud` and the AI SDK ships as `@ai-sdk/google-vertex`, whose provider is exported
 * as `vertex`. A name this table has no entry for passes through untouched, so a provider package
 * published tomorrow works here on the day it lands.
 *
 * `google-gla` and `google-vertex` are the *legacy* spellings: Pydantic AI v1's names for the two
 * halves of Google, removed in v2 in favour of `google` and `google-cloud`. They are still accepted
 * here, because a config published against a v1-era agent is still sitting in a Logfire project and
 * still has to reach a model; nothing ever writes them.
 */
const CANONICAL_TO_AI_SDK: Readonly<Record<string, string>> = {
  // Current, as Pydantic AI v2 spells them.
  'google-cloud': 'vertex',
  // Legacy, accepted as input only.
  'google-gla': 'google',
  'google-vertex': 'vertex',
}

/**
 * AI SDK provider ids the contract has a different name for, longest dotted prefix first.
 *
 * The reverse of `CANONICAL_TO_AI_SDK`, for naming a code-defined model in the baseline -- and it has
 * to read more of the provider id than the namespace, because Google is one namespace and two
 * providers: `@ai-sdk/google` reports `google.generative-ai` and `@ai-sdk/google-vertex` reports
 * `google.vertex.<api>`, so the namespace alone would publish a Vertex model as a Gemini API one and
 * offer the editor an override that reaches the wrong service.
 */
const AI_SDK_TO_CANONICAL: readonly (readonly [prefix: string, canonical: string])[] = [['google.vertex', 'google-cloud']]

/** How a managed `'provider:model'` string becomes a model this adapter can call. */
export interface ModelResolutionOptions {
  /**
   * The providers a managed model string is resolved against, as `createProviderRegistry` takes them.
   *
   * The way to say which `@ai-sdk/*` package a published `anthropic:...` should go through, and the
   * only way to reach a provider configured with your own API key, base URL, or fetch. A key here is
   * read exactly as written and before any name translation, so `{ 'google-cloud': vertex }` is how
   * you say what a contract name means to you when you would rather not rely on the translation.
   */
  providers?: Record<string, ProviderV4 | ProviderV3>
  /**
   * Full control over turning a managed model string into a model.
   *
   * Authoritative when it is passed: what it returns is the answer, and returning `undefined` means
   * "not a model I will build", which leaves the agent on its code-defined model and reports the
   * published value as unapplied. It is never a first guess that falls through to `providers` or to
   * the gateway -- a resolver that wants those for the ids it does not handle can call them itself,
   * and one that does not should not have them happen behind its back.
   */
  resolveModel?: (id: string) => LanguageModelV4 | undefined | PromiseLike<LanguageModelV4 | undefined>
}

/**
 * The specification version a model really has.
 *
 * Asked of the model *as written*, before `wrapLanguageModel` sees it. `asLanguageModelV4` wraps a v2
 * or v3 model in a `Proxy` whose only behavior is to answer `'v4'` to `specificationVersion` and
 * forward everything else, so by the time a middleware holds a model there is nothing left to tell
 * the two apart -- and the difference matters, because `reasoning` is the one call option v4 added
 * and an older provider is handed it and drops it without a word.
 */
export function specificationVersionOf(model: WrappableModel): SpecificationVersion {
  return model.specificationVersion
}

/**
 * The `'provider:model'` identifier for a model, for the baseline.
 *
 * A provider id is `<namespace>.<api>` -- `anthropic.messages` -- and the namespace is usually the
 * whole of the provider's name; `canonicalProvider` owns the cases where it is not. One more
 * exception is handled here: a gateway model's own id is already `'<provider>/<model>'`, so reporting
 * it as `gateway:anthropic/claude-fable-5-1` would publish a baseline nothing could be written
 * against. It is reported under the provider it names, which is also the form a managed value is sent
 * back to the gateway under.
 */
export function modelIdentifier(model: { provider: string; modelId: string }): string {
  const separator = model.modelId.indexOf('/')
  if (namespaceOf(model.provider) === 'gateway' && separator !== -1) {
    const provider = model.modelId.slice(0, separator)
    return `${canonicalProvider(provider)}:${model.modelId.slice(separator + 1)}`
  }
  return `${canonicalProvider(model.provider)}:${model.modelId}`
}

/** The first segment of a dotted provider id, which is usually the whole of the provider's name. */
function namespaceOf(provider: string): string {
  return provider.replace(/\..*$/u, '')
}

/**
 * The contract's name for an AI SDK provider, from its id or from a gateway model's provider segment.
 *
 * The namespace is the answer for every provider but Google, so `AI_SDK_TO_CANONICAL` is consulted
 * first -- on the longest dotted prefix that matches -- and the namespace is the fallback.
 */
function canonicalProvider(provider: string): string {
  for (const [prefix, canonical] of AI_SDK_TO_CANONICAL) {
    if (provider === prefix || provider.startsWith(`${prefix}.`)) {
      return canonical
    }
  }
  return namespaceOf(provider)
}

/**
 * A resolver for managed model strings, memoized per process.
 *
 * Memoized because it runs on every model request while the answer changes only when the published
 * value does, and because a provider package's model object is meant to be built once and reused --
 * rebuilding one per request would drop whatever it caches internally.
 */
export function createModelResolver(
  options: ModelResolutionOptions,
  report: (message: string) => void
): (id: string) => Promise<LanguageModelV4 | undefined> {
  const registry = options.providers === undefined ? undefined : createProviderRegistry(options.providers)
  const registered = new Set(Object.keys(options.providers ?? {}))
  // The *promise* rather than the model, so two requests that arrive on the same new id while the
  // first resolution is still in flight share it. Caching only the settled value would let both run
  // `resolveModel`, build two model objects for one id, and split whatever the provider caches
  // between them. A resolution that produced no model is cached too, so a published id nothing can
  // build is reported once rather than retried on every request.
  const resolved = new Map<string, Promise<LanguageModelV4 | undefined>>()

  // `async` with nothing awaited, deliberately: the body runs to completion synchronously, so the
  // promise is in the map before any caller can get back here on a later tick.
  return async (id: string): Promise<LanguageModelV4 | undefined> => {
    const cached = resolved.get(id)
    if (cached !== undefined) {
      return cached
    }
    const pending = resolveOnce(id, options.resolveModel, registry, registered, report)
    resolved.set(id, pending)
    return pending
  }
}

/**
 * Resolve one managed model string, reporting a failure rather than raising one.
 *
 * One chain, with one authoritative step at a time: a `resolveModel` the caller passed answers for
 * every id, and without one a `'provider:model'` string is translated into this ecosystem's provider
 * name and built from the caller's registry, or from the provider a bare string model would have gone
 * through. Every way of not producing a model ends in the same place -- a published section that
 * reached the right agent and did not happen, which is what `onUnmatched` governs, so a deployment
 * that would rather stop than run on the wrong model can say so.
 *
 * The report is made *outside* the `try` on purpose: under `'error'` it throws, and a throw raised
 * inside would be caught by the very handler that raised it and reported a second time as a
 * resolution failure.
 */
async function resolveOnce(
  id: string,
  resolveModel: ModelResolutionOptions['resolveModel'],
  registry: ProviderRegistryProvider | undefined,
  registered: ReadonlySet<string>,
  report: (message: string) => void
): Promise<LanguageModelV4 | undefined> {
  let failure: string
  try {
    if (resolveModel !== undefined) {
      const model = await resolveModel(id)
      if (model !== undefined) {
        return model
      }
      failure = 'which the `resolveModel` this adapter was given declined to build'
    } else if (!isQualified(id)) {
      failure = "which is not in 'provider:model' form"
    } else {
      return await fromProvider(providerFor(id, registered), registry)
    }
  } catch (error) {
    failure = `which could not be resolved (${error instanceof Error ? error.message : String(error)})`
  }
  report(`Managed agent config selects model '${id}', ${failure}; keeping the code-defined model.`)
  return undefined
}

function isQualified(id: string): id is QualifiedModelId {
  return id.includes(':')
}

/**
 * The published id with its provider translated into the name this ecosystem knows it by.
 *
 * A key the caller registered themselves is read first and exactly as written: a `providers` record
 * is the caller saying what a name means to them, and this module's table has no business overruling
 * it. Every other name is translated where there is a translation and forwarded where there is not,
 * because a name with no AI SDK equivalent still fails in the right place -- the registry or the
 * gateway raises, which is caught and reported as a model that could not be resolved, and the agent
 * keeps the model its code defines.
 */
function providerFor(id: QualifiedModelId, registered: ReadonlySet<string>): QualifiedModelId {
  const separator = id.indexOf(':')
  const provider = id.slice(0, separator)
  if (registered.has(provider)) {
    return id
  }
  const translated = CANONICAL_TO_AI_SDK[provider]
  return translated === undefined ? id : `${translated}:${id.slice(separator + 1)}`
}

/** The registry the caller configured, else the provider a bare string model would have gone to. */
async function fromProvider(id: QualifiedModelId, registry: ProviderRegistryProvider | undefined): Promise<LanguageModelV4> {
  return registry === undefined ? gatewayModel(id) : registry.languageModel(id)
}

/**
 * The last resort: the same provider a bare string model would have gone through.
 *
 * `generateText({model: 'anthropic/claude-fable-5-1'})` resolves through
 * `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway` (`ai/src/model/resolve-model.ts`), and a managed
 * model string should end up at the same place a code-written one would. The gateway is imported
 * lazily rather than depended on, so an application that never publishes a model string -- or that
 * passes `providers` -- does not have to have it installed.
 */
async function gatewayModel(id: QualifiedModelId): Promise<LanguageModelV4> {
  const configured = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: ProviderV4 }).AI_SDK_DEFAULT_PROVIDER
  const provider = configured ?? (await import('@ai-sdk/gateway')).gateway
  return provider.languageModel(id.replace(':', '/'))
}
