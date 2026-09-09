/**
 * Lowering the contract's canonical settings onto Mastra's, and raising Mastra's back for a baseline.
 *
 * Mastra's own settings are the AI SDK's `CallSettings` plus two of its own (`reasoning`, `timeout`),
 * so most of this is a `snake_case`-to-`camelCase` rename. The interesting keys are the three the AI
 * SDK has no field for at all: `timeout`, which Mastra splits per step and per run; `thinking`, which
 * only a v7 provider honours; and `parallel_tool_calls`, which lives in provider options under a
 * different name -- and a different polarity -- for each provider.
 */

import { mergeSettings, toMilliseconds } from '@pydantic/logfire-node/agent-control'
import type { AgentConfigSettings } from '@pydantic/logfire-node/agent-control'

/** Canonical settings that are one rename away from a Mastra model setting. */
const RENAMED = {
  max_tokens: 'maxOutputTokens',
  temperature: 'temperature',
  top_p: 'topP',
  top_k: 'topK',
  seed: 'seed',
  presence_penalty: 'presencePenalty',
  frequency_penalty: 'frequencyPenalty',
  stop_sequences: 'stopSequences',
} as const satisfies Partial<Record<keyof AgentConfigSettings, string>>

/**
 * How a canonical `thinking` reaches Mastra's `reasoning`.
 *
 * The contract's levels are the AI SDK's levels, word for word, so only the two booleans need a
 * decision: `true` asks for reasoning without saying how much, which is what `'provider-default'`
 * means, and `false` asks for none, which the SDK spells `'none'`.
 */
const THINKING = {
  true: 'provider-default',
  false: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
} as const

/** The keys of `THINKING`, which are exactly the values the contract lets `thinking` take. */
type ThinkingKey = keyof typeof THINKING

/** The reverse, for a baseline. `'provider-default'` and `'none'` are the booleans they came from. */
const REASONING: Readonly<Record<string, AgentConfigSettings['thinking']>> = {
  'provider-default': true,
  none: false,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
}

/**
 * Where each provider keeps "may the model call several tools at once".
 *
 * The AI SDK has no call setting for it, so it is a provider option, and the two providers that
 * expose one disagree about both its name and its sense: OpenAI asks whether parallel calls are
 * allowed, Anthropic asks whether they are disabled. A provider not in this table has no knob to
 * lower it onto, which is reported rather than guessed at.
 */
const PARALLEL_TOOL_CALLS: Readonly<Record<string, { key: string; negated: boolean }>> = {
  openai: { key: 'parallelToolCalls', negated: false },
  anthropic: { key: 'disableParallelToolUse', negated: true },
}

/** Every Mastra model setting this adapter writes, which is also every one a run can take back. */
const MANAGED_MODEL_SETTINGS: readonly string[] = [...Object.values(RENAMED), 'reasoning', 'timeout']

/**
 * Provider options this adapter writes, which are booleans and only booleans.
 *
 * Narrower than the AI SDK's `Record<string, JSONValue>` on purpose: `parallel_tool_calls` is the one
 * canonical setting with no home outside provider options, so anything wider would be room for a
 * shape the contract has no way to express.
 */
type ProviderOptionsPatch = Record<string, Record<string, boolean>>

/** One settings object as it reaches a step, and the agent's own defaults it was merged onto. */
export interface SettingsLayers<T> {
  /**
   * What the step would run with: the agent's defaults with this run's own values merged in.
   *
   * Mastra deep-merges a call's `modelSettings` and `providerOptions` into the agent's
   * `defaultOptions` before the loop starts, so by the time a processor sees them the two are one
   * object and nothing records which value came from where.
   */
  effective: Readonly<Record<string, T>> | undefined
  /** The agent's own defaults, which is what a value this run chose is recognised by differing from. */
  defaults: Readonly<Record<string, T>> | undefined
}

/** What a published `settings` section becomes on Mastra's side. */
export interface LoweredSettings {
  /** The `modelSettings` to return for this step, or `undefined` when nothing about them changes. */
  modelSettings: Record<string, unknown> | undefined
  /** The `providerOptions` to return for this step, or `undefined` when nothing about them changes. */
  providerOptions: Record<string, Record<string, unknown>> | undefined
  /** Canonical keys that reached no Mastra knob, for `reportUnapplied`. */
  unapplied: string[]
}

/** What the lowering needs to know about the request it is lowering for. */
export interface LoweringContext {
  /** The provider serving this step, for the settings that only exist as provider options. */
  provider: string | undefined
  /**
   * Whether this step's model would honour `reasoning`.
   *
   * Mastra passes `reasoning` only to AI SDK v7 (`LanguageModelV4`) providers and silently drops it
   * for older ones, and a setting dropped without a word is the one thing this contract exists to
   * prevent -- so where it would be dropped, it is reported instead.
   */
  supportsReasoning: boolean
  /** The step's model settings, and the agent defaults they were merged onto. */
  modelSettings: SettingsLayers<unknown>
  /** The step's provider options, and the agent defaults they were merged onto. */
  providerOptions: SettingsLayers<Readonly<Record<string, unknown>>>
}

/**
 * Lower a canonical settings patch onto Mastra's model settings and provider options.
 *
 * The contract's precedence is code < published < the values this run passed explicitly, and it is
 * the core's `mergeSettings` that implements it here rather than anything local: each layer is handed
 * over as it is, and what comes back is the object to send with a record of which layer won each key.
 * That provenance is why a published `parallel_tool_calls` can no longer stamp over a run that set
 * `openai.parallelToolCalls` for itself -- the two live in different places, and only the merge knows
 * which of them the run asked for.
 *
 * The run layer is **recovered by diffing**, because Mastra merges a call's settings into the agent's
 * defaults before any processor runs and offers a processor nothing that says which keys the call
 * carried. A key whose value at the step differs from the agent's default is one this run chose. The
 * cost is the case that cannot be recovered: a call passing a value *equal* to the agent's default is
 * indistinguishable from a call that passed nothing, and the published value wins there. It is the
 * weaker of the two contracts and it is documented as such; it is not fixable by diffing harder.
 *
 * Everything the framework cannot express comes back in `unapplied` rather than being dropped: the
 * caller reports those under the same `onUnmatched` policy the rest of the config is applied with.
 */
export function lowerSettings(settings: AgentConfigSettings, context: LoweringContext): LoweredSettings {
  const published: Record<string, unknown> = {}
  const unapplied: string[] = []

  for (const [canonicalKey, mastraKey] of Object.entries(RENAMED)) {
    const value = settings[canonicalKey as keyof typeof RENAMED]
    if (value !== undefined) {
      published[mastraKey] = value
    }
  }

  if (settings.timeout !== undefined) {
    // Mastra's timeout is a budget object, in milliseconds, split between the whole run (`totalMs`)
    // and one model call (`stepMs`). The contract's `timeout` is seconds and is per model request,
    // which is `stepMs`; merging rather than replacing is what leaves a run-wide `totalMs` set in
    // code exactly where it was. `applySettings` has already dropped and reported a timeout that is
    // not a representable budget, so this conversion cannot be handed one.
    const current = context.modelSettings.effective?.['timeout']
    const budget = isRecord(current) ? current : {}
    published['timeout'] = { ...budget, stepMs: toMilliseconds(settings.timeout) }
  }

  if (settings.thinking !== undefined) {
    // The cast is exhaustive by construction: `THINKING` has a key for every value the contract's
    // `thinking` can take, both booleans included, so stringifying one always lands on a key.
    const reasoning = THINKING[String(settings.thinking) as ThinkingKey]
    if (context.supportsReasoning) {
      published['reasoning'] = reasoning
    } else {
      unapplied.push('thinking')
    }
  }

  const provider = context.provider
  const publishedOptions: ProviderOptionsPatch = {}
  if (settings.parallel_tool_calls !== undefined) {
    const option = provider === undefined ? undefined : PARALLEL_TOOL_CALLS[provider]
    if (provider === undefined || option === undefined) {
      unapplied.push('parallel_tool_calls')
    } else {
      publishedOptions[provider] = {
        [option.key]: option.negated ? !settings.parallel_tool_calls : settings.parallel_tool_calls,
      }
    }
  }

  return {
    modelSettings: merged(context.modelSettings, published, MANAGED_MODEL_SETTINGS),
    providerOptions: mergedProviderOptions(context.providerOptions, publishedOptions),
    unapplied,
  }
}

/**
 * The settings to send for this step, or `undefined` when the published ones change nothing.
 *
 * `undefined` rather than a copy because Mastra rebuilds the step from a returned `modelSettings`,
 * and handing back an object equal to the one it already has is work and noise in the trace for
 * nothing.
 */
function merged(
  layers: SettingsLayers<unknown>,
  published: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  if (Object.keys(published).length === 0) {
    return undefined
  }
  const settings = mergeSettings(layers.effective, published, runValues(layers, keys)).settings
  const changed = Object.keys(published).some((key) => !same(settings[key], layers.effective?.[key]))
  return changed ? settings : undefined
}

/** The same, per provider, since each provider's options are their own namespace to merge in. */
function mergedProviderOptions(
  layers: SettingsLayers<Readonly<Record<string, unknown>>>,
  published: ProviderOptionsPatch
): Record<string, Record<string, unknown>> | undefined {
  const merge: Record<string, Record<string, unknown>> = {}
  let changed = false
  for (const [provider, options] of Object.entries(published)) {
    const inner: SettingsLayers<unknown> = {
      effective: layers.effective?.[provider],
      defaults: layers.defaults?.[provider],
    }
    const result = merged(inner, options, Object.keys(options))
    if (result === undefined) {
      continue
    }
    merge[provider] = result
    changed = true
  }
  if (!changed) {
    return undefined
  }
  // Every other provider's options are carried across: a returned `providerOptions` replaces the
  // step's, so a managed `openai` key would otherwise take an `anthropic` block with it.
  return { ...layers.effective, ...merge }
}

/**
 * The values this run chose for itself, as the explicit layer `mergeSettings` takes.
 *
 * Only the keys a published value could otherwise overwrite are looked at: the rest of a step's
 * settings are its own either way, and there is nothing to attribute.
 */
function runValues(layers: SettingsLayers<unknown>, keys: readonly string[]): Record<string, unknown> {
  const explicit: Record<string, unknown> = {}
  for (const key of keys) {
    const value = layers.effective?.[key]
    if (!same(value, layers.defaults?.[key])) {
      explicit[key] = value
    }
  }
  return explicit
}

/** Structural equality, for settings values that may be arrays (`stopSequences`) or objects (`timeout`). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (a === undefined || b === undefined) {
    return false
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Raise Mastra's settings back to the canonical ones, for the baseline.
 *
 * The inverse of `lowerSettings`, minus the parts a baseline has no use for: only the keys the
 * contract names are described, so a value the Logfire editor offers is a value that can be published
 * back. `core.buildBaseline` filters to the canonical keys again, which makes this the place to get
 * the *units* right rather than the vocabulary.
 *
 * `provider` is the one the agent's code-defined model names, and it decides which namespace
 * `parallel_tool_calls` is read from -- an agent may carry provider options for a provider it is not
 * running on, and those are not settings this agent has.
 */
export function raiseSettings(
  modelSettings: Readonly<Record<string, unknown>> | undefined,
  providerOptions: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  provider: string | undefined
): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  if (modelSettings !== undefined) {
    for (const [canonicalKey, mastraKey] of Object.entries(RENAMED)) {
      const value = modelSettings[mastraKey]
      if (value !== undefined) {
        settings[canonicalKey] = value
      }
    }
    const timeout = modelSettings['timeout']
    if (isRecord(timeout) && typeof timeout['stepMs'] === 'number') {
      settings['timeout'] = timeout['stepMs'] / 1000
    }
    const reasoning = modelSettings['reasoning']
    const thinking = typeof reasoning === 'string' ? REASONING[reasoning] : undefined
    if (thinking !== undefined) {
      settings['thinking'] = thinking
    }
  }
  // Only the provider that will serve the agent. Options under another provider's namespace are
  // inert for this agent, and raising one would describe the agent as having a setting it does not
  // have -- which a publish would then turn into a setting it does.
  const option = provider === undefined ? undefined : PARALLEL_TOOL_CALLS[provider]
  const value = option === undefined || provider === undefined ? undefined : providerOptions?.[provider]?.[option.key]
  if (option !== undefined && typeof value === 'boolean') {
    settings['parallel_tool_calls'] = option.negated ? !value : value
  }
  return settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
