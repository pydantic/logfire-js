/**
 * The install: `agentControl({ settings })` for an agent, `agentControl({ model })` for a model.
 *
 * One function with one options bag, because there is one question -- which agent is this? -- and the
 * rest is what you happen to be holding. An agent's settings object is where the AI SDK keeps
 * everything Agent Control manages, and it is plain data until the agent is constructed from it, so
 * wrapping the settings rather than the agent needs no access to anything private and leaves the
 * agent an ordinary `ToolLoopAgent`. It also lets this helper hand the middleware three things a
 * middleware installed on a bare model cannot know: the instructions the agent declares, the settings
 * it declares, and the version of the model it declares -- which is what makes a block addressable,
 * a block's text publishable, and a per-run setting win over a managed one.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { Context, ToolSet } from '@ai-sdk/provider-utils'
import type { Instructions, LanguageModel, OutputInterface, ToolLoopAgentSettings } from 'ai'
import { wrapLanguageModel } from 'ai'

import { agentControlMiddleware, requireName } from './middleware'
import type { AgentControlOptions } from './middleware'
import { specificationVersionOf } from './model'
import type { WrappableModel } from './model'
import type { CallSettings } from './settings'

/** Manage an agent: everything Agent Control needs, plus the agent's own settings object. */
export interface AgentControlSettingsOptions<
  CALL_OPTIONS = never,
  // `{}` is the default `ToolLoopAgentSettings` itself declares for this parameter, and repeating it
  // is what keeps `agentControl` inferring exactly what `new ToolLoopAgent(...)` would. A narrower
  // stand-in for "no tools" would infer differently.
  // oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type
  TOOLS extends ToolSet = {},
  RUNTIME_CONTEXT extends Context = Context,
  OUTPUT extends OutputInterface = never,
  S extends ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT> = ToolLoopAgentSettings<
    CALL_OPTIONS,
    TOOLS,
    RUNTIME_CONTEXT,
    OUTPUT
  >,
> extends Omit<AgentControlOptions, 'codeInstructions' | 'codeSettings' | 'modelSpecificationVersion'> {
  /**
   * The settings you would have passed to `new ToolLoopAgent(...)`.
   *
   * Read as well as wrapped: its `instructions`, its generation settings, and the specification
   * version of its `model` are what this form knows and a bare model install does not.
   */
  settings: S
}

/** Manage one model, for `generateText`, `streamText`, or anywhere a `LanguageModel` goes. */
export interface AgentControlModelOptions extends AgentControlOptions {
  /** The model the agent would run on, which a managed `model` replaces. */
  model: WrappableModel
}

/**
 * Settings with Agent Control installed: the same agent, with the fields this helper fills in.
 *
 * Spelled out rather than returned as the input type, because `id` and `telemetry.functionId` are no
 * longer optional afterwards -- an agent that came out of here has a name, and that is worth being
 * able to read back.
 */
export type ManagedSettings<S> = Omit<S, 'id' | 'model' | 'telemetry'> & {
  id: string
  model: LanguageModelV4
  telemetry: { functionId: string }
}

/**
 * Manage an agent's settings from Logfire.
 *
 * ```ts
 * export const agent = new ToolLoopAgent(
 *   agentControl({
 *     settings: {
 *       id: 'checkout_assistant',
 *       model: anthropic('claude-fable-5-1'),
 *       instructions: 'You are a concise checkout assistant.',
 *       tools: { get_weather },
 *     },
 *   }),
 * );
 * ```
 *
 * What comes back is the same settings with three changes: the model is wrapped in the Agent Control
 * middleware, and `id` and `telemetry.functionId` are filled in from the Agent Control name if the
 * agent does not already carry them -- so the spans this agent emits are grouped under the name its
 * config is published against, which is what lets someone move between the trace and the config that
 * produced it.
 *
 * The agent's name is `options.name`, else its `id`, else its `telemetry.functionId`. It is never
 * derived from anything else, and an agent with none of the three is refused rather than published
 * under a guess.
 */
export function agentControl<
  CALL_OPTIONS = never,
  // `{}` is the default `ToolLoopAgentSettings` itself declares for this parameter, and repeating it
  // is what keeps `agentControl` inferring exactly what `new ToolLoopAgent(...)` would. A narrower
  // stand-in for "no tools" would infer differently.
  // oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type
  TOOLS extends ToolSet = {},
  RUNTIME_CONTEXT extends Context = Context,
  OUTPUT extends OutputInterface = never,
  S extends ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT> = ToolLoopAgentSettings<
    CALL_OPTIONS,
    TOOLS,
    RUNTIME_CONTEXT,
    OUTPUT
  >,
>(options: AgentControlSettingsOptions<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT, S>): ManagedSettings<S>

/**
 * Manage every request through one model.
 *
 * ```ts
 * const model = agentControl({ model: anthropic('claude-fable-5-1'), name: 'checkout_assistant' });
 * const { text } = await generateText({ model, instructions: 'Be concise.', prompt: 'Hi' });
 * ```
 *
 * Pass `codeInstructions` and `codeSettings` to say what your code declares, which is what lets a
 * per-call value beat a published one and keeps the baseline describing your code rather than your
 * first request.
 */
export function agentControl(options: AgentControlModelOptions): LanguageModelV4

export function agentControl(options: AgentControlModelOptions | AgentControlSettingsOptions): unknown {
  return 'model' in options ? managedModel(options) : managedSettings(options)
}

function managedModel(options: AgentControlModelOptions): LanguageModelV4 {
  const { model, ...rest } = options
  return wrapLanguageModel({
    model,
    middleware: agentControlMiddleware({ modelSpecificationVersion: specificationVersionOf(model), ...rest }),
  })
}

function managedSettings(options: AgentControlSettingsOptions): ManagedSettings<ToolLoopAgentSettings> {
  const { settings, ...rest } = options
  const name = requireName(
    options.name ?? settings.id ?? settings.telemetry?.functionId,
    'Give the agent an `id`, or pass `{ name }` to `agentControl`.'
  )
  const model = wrappableModel(settings.model)
  const managed = wrapLanguageModel({
    model,
    middleware: agentControlMiddleware({
      ...rest,
      name,
      ...(settings.instructions === undefined ? {} : { codeInstructions: settings.instructions }),
      codeSettings: declaredSettings(settings),
      modelSpecificationVersion: specificationVersionOf(model),
    }),
  })
  return {
    ...settings,
    id: settings.id ?? name,
    telemetry: { ...settings.telemetry, functionId: settings.telemetry?.functionId ?? name },
    model: managed,
    // TypeScript cannot prove that spreading a generic and replacing three of its properties produces
    // the mapped type that says exactly that, which is what this does.
  } as unknown as ManagedSettings<ToolLoopAgentSettings>
}

/** The settings fields this helper reads off an agent, which is the half it has anything to say about. */
type DeclaredSettings = CallSettings & { instructions?: Instructions }

/**
 * The generation settings the agent declares, which is what the middleware compares a request to.
 *
 * A field the agent leaves unset is carried over as `undefined` rather than dropped, because that is
 * what it means: a request that carries a value for it did not inherit that value from the agent.
 */
function declaredSettings(settings: DeclaredSettings): CallSettings {
  const { maxOutputTokens, temperature, topP, topK, presencePenalty, frequencyPenalty, stopSequences, seed, reasoning, providerOptions } =
    settings
  return {
    maxOutputTokens,
    temperature,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    stopSequences,
    seed,
    reasoning,
    providerOptions,
  }
}

/**
 * The model to wrap, which has to be a model object rather than a string.
 *
 * A string model is resolved by the AI SDK at call time, through the AI Gateway or whatever
 * `AI_SDK_DEFAULT_PROVIDER` names -- after this helper has run, so there is nothing here to wrap.
 * Refusing is better than silently managing nothing: the fix is one import, and the alternative is
 * an agent that reports itself as managed and applies no config.
 */
function wrappableModel(model: LanguageModel): WrappableModel {
  if (typeof model !== 'string') {
    return model
  }
  throw new Error(
    `Logfire Agent Control cannot manage the string model '${model}': a string is resolved to a model ` +
      'by the AI SDK at call time, so there is nothing to wrap. Pass a model object instead, for ' +
      "example `gateway('" +
      model +
      "')` or your provider's own factory."
  )
}
