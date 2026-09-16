/**
 * The canonical settings, lowered onto the AI SDK's call options, and read back out for a baseline.
 *
 * Most of the contract is a rename away from `LanguageModelV4CallOptions` (`max_tokens` ->
 * `maxOutputTokens`, and the rest camelCase for camelCase). Three are not, and each is called out
 * where it is handled: `thinking` is an effort enum here and only a v4 provider has one, `timeout` is
 * not a call option at all, and `parallel_tool_calls` exists only inside a provider's own options.
 *
 * # Precedence
 *
 * The contract's order is code < published < what a run passed explicitly, and the merge that
 * implements it is the core's `mergeSettings`, which has to be told which keys the run set. The AI
 * SDK cannot say. By the time a request reaches a language model middleware the agent's settings and
 * the call's are one object with no record of which came from where, and the seam upstream is no
 * better: `agent.generate()` takes no generation settings at all, and `prepareCall` -- the one
 * per-run hook that does -- is a whole-object transform whose idiom is to spread everything it did
 * not change, so a key it wrote and a key it passed through are the same key. There is no boundary
 * that knows.
 *
 * What is left is a comparison: a request field that differs from what the agent declares is one this
 * run chose. That is exact except when a run sets a key to the value the code already had, which is
 * indistinguishable from inheriting it and where a published value wins. The core's merge is still
 * what applies it, because the layering, the cleared keys, and the provenance a provider option needs
 * are all the same problem, and one of them being approximate is no reason to solve the rest again
 * here. The README says which case is approximate.
 */

import type { AgentConfig, AgentConfigSettings, OnUnmatched, SettingsLayer } from '@pydantic/logfire-node/agent-control'
import {
  applySettings,
  CANONICAL_SETTINGS_KEYS,
  mergeSettings,
  reportUnapplied,
  toMilliseconds,
} from '@pydantic/logfire-node/agent-control'
import type { LanguageModelV4CallOptions, SharedV4ProviderOptions } from '@ai-sdk/provider'

import type { SpecificationVersion } from './model'

/**
 * The AI SDK's model-facing generation controls: the settings both an agent and a call can set.
 *
 * Every field is explicitly `| undefined` rather than merely optional, so an unset one can be
 * written out as `undefined` instead of having to be left off -- which is what lets the agent helper
 * hand over what its agent declares in one destructuring, unset fields and all.
 */
export interface CallSettings {
  maxOutputTokens?: number | undefined
  temperature?: number | undefined
  topP?: number | undefined
  topK?: number | undefined
  presencePenalty?: number | undefined
  frequencyPenalty?: number | undefined
  stopSequences?: string[] | undefined
  seed?: number | undefined
  reasoning?: LanguageModelV4CallOptions['reasoning'] | undefined
  /**
   * The provider's own options, which is where `parallel_tool_calls` lives.
   *
   * Part of the declared settings rather than of the request alone, because it is the only way to
   * tell a run that deliberately set `openai.parallelToolCalls` from one that inherited it.
   */
  providerOptions?: SharedV4ProviderOptions | undefined
}

/**
 * One of the contract's eleven canonical settings keys.
 *
 * `keyof AgentConfigSettings` on its own also admits the symbol the core hangs a published value's
 * unrecognized keys off, which is not a setting anything here can carry.
 */
type CanonicalKey = keyof AgentConfigSettings & string

/** Canonical key to the AI SDK field that carries it, for the settings that are a rename apart. */
const DIRECT_KEYS = {
  max_tokens: 'maxOutputTokens',
  temperature: 'temperature',
  top_p: 'topP',
  top_k: 'topK',
  presence_penalty: 'presencePenalty',
  frequency_penalty: 'frequencyPenalty',
  stop_sequences: 'stopSequences',
  seed: 'seed',
} as const satisfies Partial<Record<CanonicalKey, keyof CallSettings>>

type DirectKey = keyof typeof DIRECT_KEYS

const DIRECT_ENTRIES = Object.entries(DIRECT_KEYS) as [DirectKey, (typeof DIRECT_KEYS)[DirectKey]][]

/**
 * The provider option each provider exposes `parallel_tool_calls` through.
 *
 * There is no call option for it: the AI SDK leaves parallel tool calling to the provider, so the
 * canonical key can only be lowered where a provider has a field for it. `inverted` is Anthropic's,
 * which spells the same knob as `disableParallelToolUse`.
 */
const PARALLEL_TOOL_CALLS = {
  openai: { key: 'parallelToolCalls', inverted: false },
  anthropic: { key: 'disableParallelToolUse', inverted: true },
} as const

/**
 * The `providerOptions` namespace a model's options are read from.
 *
 * A provider id is `<namespace>.<api>` -- `anthropic.messages`, `openai.responses` -- and every one
 * of them parses `providerOptions` under the namespace alone.
 */
export function providerNamespace(provider: string): string {
  return provider.replace(/\..*$/u, '')
}

function parallelOption(namespace: string): (typeof PARALLEL_TOOL_CALLS)[keyof typeof PARALLEL_TOOL_CALLS] | undefined {
  return PARALLEL_TOOL_CALLS[namespace as keyof typeof PARALLEL_TOOL_CALLS]
}

/**
 * The canonical settings this request could actually carry, which is not the same for every model.
 *
 * Two of the eleven depend on where the request is going. `thinking` is lowered onto `reasoning`,
 * which is the one call option `LanguageModelV4` added: a v2 or v3 provider reached through
 * `wrapLanguageModel`'s bridge is handed that field and drops it without a word, so applying one for
 * such a model would be a published setting that changes nothing. `parallel_tool_calls` has no call
 * option at all and exists only where a provider has its own field for it.
 *
 * Used in both directions -- what a published value may set, and what a baseline may claim the agent
 * does -- so the Logfire editor is never shown a key this request would ignore.
 */
export function supportedSettings(namespace: string, specificationVersion: SpecificationVersion): ReadonlySet<CanonicalKey> {
  const supported = new Set<CanonicalKey>([...DIRECT_ENTRIES.map(([canonical]) => canonical), 'timeout'])
  if (specificationVersion === 'v4') {
    supported.add('thinking')
  }
  if (parallelOption(namespace) !== undefined) {
    supported.add('parallel_tool_calls')
  }
  return supported
}

/** `thinking` as the AI SDK's reasoning effort, and back. */
function toReasoning(thinking: NonNullable<AgentConfigSettings['thinking']>): NonNullable<CallSettings['reasoning']> {
  if (thinking === true) {
    return 'provider-default'
  }
  if (thinking === false) {
    return 'none'
  }
  return thinking
}

function fromReasoning(reasoning: CallSettings['reasoning']): AgentConfigSettings['thinking'] {
  if (reasoning === undefined) {
    return undefined
  }
  if (reasoning === 'provider-default') {
    return true
  }
  if (reasoning === 'none') {
    return false
  }
  return reasoning
}

/** Options for `lowerSettings`. */
export interface LowerSettingsOptions {
  /** The request as the AI SDK assembled it, which a managed value patches. */
  params: LanguageModelV4CallOptions
  /**
   * The settings the agent declares in code, when the adapter was given them.
   *
   * Both the code layer of the merge and the only evidence there is for which keys this run set,
   * since a request field that differs from what the code declares is one this run chose. Leaving it
   * out is the weaker contract: with no code layer to compare against, a published value wins every
   * key it names.
   */
  code?: CallSettings | undefined
  /** The `providerOptions` namespace of the model this request will actually go to. */
  namespace: string
  /** The specification version of the model this request will actually go to. */
  specificationVersion: SpecificationVersion
  onUnmatched: OnUnmatched
}

/**
 * The call options a managed `settings` section changes, as a patch over `params`.
 *
 * Only the keys the *published* layer wins are in the patch. A key the run set explicitly, and a key
 * only the code sets, are already in `params` with the value they should have, so writing either back
 * could only ever change it -- which is the mistake this shape makes unrepresentable.
 *
 * Every canonical key that reaches nothing is reported: one this SDK has no field for, by
 * `applySettings`; one this model cannot honour -- `thinking` on a pre-v4 provider,
 * `parallel_tool_calls` on a provider with no knob for it -- here.
 */
export function lowerSettings(config: AgentConfig, options: LowerSettingsOptions): Partial<LanguageModelV4CallOptions> {
  const { params, code, namespace, specificationVersion, onUnmatched } = options
  const supported = supportedSettings(namespace, specificationVersion)
  const settings = applySettings(config, { onUnmatched })
  const published: CanonicalSettings = {}
  const unapplied: string[] = []
  for (const key of CANONICAL_SETTINGS_KEYS) {
    const value = settings[key]
    if (value === undefined) {
      continue
    }
    if (supported.has(key)) {
      ;(published as Record<string, unknown>)[key] = value
    } else {
      unapplied.push(key)
    }
  }
  reportUnapplied(unapplied, { onUnmatched })

  const codeLayer = code === undefined ? undefined : canonicalSettings(code, namespace, supported)
  const requestLayer = canonicalSettings(params, namespace, supported)
  const { sources } = mergeSettings(codeLayer, published, runLayer(requestLayer, codeLayer))
  const wins = (key: CanonicalKey): boolean => sources.get(key) === 'published'

  const patch: Partial<LanguageModelV4CallOptions> = {}
  for (const [canonical, field] of DIRECT_ENTRIES) {
    const value = published[canonical]
    if (value !== undefined && wins(canonical)) {
      ;(patch as Record<string, unknown>)[field] = value
    }
  }

  if (published.thinking !== undefined && wins('thinking')) {
    patch.reasoning = toReasoning(published.thinking)
  }

  // `timeout` is not a call option; the AI SDK's own timeouts live one layer up, on the call, and by
  // the time one reaches a model it has become an `AbortSignal` indistinguishable from the one a
  // caller passes to cancel a run. So the published budget is composed with whatever signal the
  // request carries -- whichever fires first aborts -- rather than replacing it, which also means a
  // per-run timeout *longer* than the published one cannot win at this seam. See the README's known
  // limits. `toMilliseconds` is the core's conversion: a budget too small to round to a millisecond
  // comes back as 1 rather than as the fractional delay `AbortSignal.timeout` throws on.
  if (published.timeout !== undefined) {
    const timeout = AbortSignal.timeout(toMilliseconds(published.timeout))
    patch.abortSignal = params.abortSignal === undefined ? timeout : AbortSignal.any([params.abortSignal, timeout])
  }

  const option = parallelOption(namespace)
  if (published.parallel_tool_calls !== undefined && option !== undefined && wins('parallel_tool_calls')) {
    patch.providerOptions = {
      ...params.providerOptions,
      [namespace]: {
        ...params.providerOptions?.[namespace],
        [option.key]: option.inverted ? !published.parallel_tool_calls : published.parallel_tool_calls,
      },
    }
  }

  return patch
}

/**
 * The layer holding what this run set for itself, as far as anything here can tell.
 *
 * A request field that differs from what the agent declares is one this run chose; see the module
 * comment for the one case that misses. With no declared settings at all there is no evidence
 * whatsoever, which the core reads as "this adapter cannot see the run layer" -- and a published
 * value then wins every key -- rather than as "the run set nothing".
 */
function runLayer(request: CanonicalSettings, code: CanonicalSettings | undefined): SettingsLayer {
  if (code === undefined) {
    return undefined
  }
  const layer: Record<string, unknown> = {}
  for (const key of CANONICAL_SETTINGS_KEYS) {
    const value = request[key]
    if (value !== undefined && !sameValue(value, code[key])) {
      layer[key] = value
    }
  }
  return layer
}

/**
 * The canonical settings, as a mapping the core's merge and baseline can both read.
 *
 * `AgentConfigSettings` with an index signature, which is what `mergeSettings` and `buildBaseline`
 * take: both read a framework's settings by name, and neither can be given an interface that
 * TypeScript will not let them index.
 */
export type CanonicalSettings = AgentConfigSettings & Record<string, unknown>

/** Whether two canonical settings values are the same one; the only structured value is a list. */
function sameValue(one: unknown, other: unknown): boolean {
  if (Array.isArray(one) && Array.isArray(other)) {
    return one.length === other.length && one.every((item, index) => item === other[index])
  }
  return one === other
}

/**
 * The canonical settings a set of AI SDK call options carries.
 *
 * Filtered to `supported`, so neither the baseline nor the precedence merge ever names a key this
 * request's model would ignore: publishing an effort level a v3 provider drops would offer the editor
 * a change that does nothing.
 *
 * `timeout` is deliberately never produced. At this layer it is an `AbortSignal`, which says nothing
 * about how long it was armed for, so there is no honest value to report as the code-side one.
 */
export function canonicalSettings(settings: CallSettings, namespace: string, supported: ReadonlySet<CanonicalKey>): CanonicalSettings {
  const canonical: CanonicalSettings = {}
  for (const [key, field] of DIRECT_ENTRIES) {
    const value = settings[field]
    if (value !== undefined && supported.has(key)) {
      ;(canonical as Record<string, unknown>)[key] = value
    }
  }
  const thinking = fromReasoning(settings.reasoning)
  if (thinking !== undefined && supported.has('thinking')) {
    canonical.thinking = thinking
  }

  const option = parallelOption(namespace)
  if (option !== undefined && supported.has('parallel_tool_calls')) {
    const parallel = settings.providerOptions?.[namespace]?.[option.key]
    if (typeof parallel === 'boolean') {
      canonical.parallel_tool_calls = option.inverted ? !parallel : parallel
    }
  }
  return canonical
}
