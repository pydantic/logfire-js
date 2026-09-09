/**
 * The hook: one `LanguageModelMiddleware` that applies a managed config to every model request.
 *
 * `wrapLanguageModel` is the AI SDK's only per-model-request seam, and it is enough for all four
 * sections. What reaches it is the full `LanguageModelV4CallOptions` -- the system messages, the
 * tools with their resolved JSON Schemas, and every generation setting -- which is everything a
 * managed config patches; what comes back is where a renamed tool call has to be mapped to the tool
 * the code actually implements, before the SDK looks the name up and finds nothing.
 *
 * # Why the rewrite happens in `wrapGenerate` rather than in `transformParams`
 *
 * The natural place for a parameter rewrite is `transformParams`, and the natural place to map a
 * result back is `wrapGenerate` -- but they are two calls, and one model request would then resolve
 * the variable twice and have to smuggle the routing table from the first to the second.
 * `wrapGenerate` and `wrapStream`, on the other hand, are already a scope around the whole request:
 * the `doGenerate` they are handed is literally `() => model.doGenerate(params)`, so calling
 * `model.doGenerate(ourParams)` in its place transforms and executes in one place.
 *
 * That one scope is what `AgentControl.run` needs. Everything inside it carries the resolved label
 * on its spans, so the trace for a request says which published version drove it -- which is the
 * difference between "this agent regressed" and "this agent regressed on the value someone saved at
 * 14:02". It is also what makes the model swap ordinary rather than special: a managed model is just
 * a different object to call with the same params.
 */

import type { AgentConfig, OnUnmatched } from '@pydantic/logfire-node/agent-control'
import { AgentControl, applyInstructions, buildBaseline, warnOnce } from '@pydantic/logfire-node/agent-control'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider'
import type { Instructions, LanguageModelMiddleware } from 'ai'

import { baselineBlockOf, blockOf, CodeInstructions, instructionMessages, systemSlots, writeSystemMessages } from './instructions'
import { createModelResolver, modelIdentifier } from './model'
import type { ModelResolutionOptions, SpecificationVersion } from './model'
import { canonicalSettings, lowerSettings, providerNamespace, supportedSettings } from './settings'
import type { CallSettings } from './settings'
import { applyToTools, renameHistory, renameToolChoice, toolDefs, unrenameContent, unrenameStreamPart } from './tools'

/** How an agent is managed: which variable it reads, and what this adapter is allowed to know. */
export interface AgentControlOptions extends ModelResolutionOptions {
  /**
   * The name of the agent, which picks out the `agent__<name>` Logfire variable holding its config.
   *
   * Required and never derived from anything the AI SDK carries. `ToolLoopAgent`'s `id` and
   * `telemetry.functionId` are both optional and both free-form, so guessing at one would let two
   * agents share a config, or move an agent onto a different config the day someone renames it.
   */
  name?: string
  /** Read this label instead of letting the variable's rollout choose one. */
  label?: string
  /** What to do with a published entry that reaches nothing: `'warn'` (default), `'ignore'`, `'error'`. */
  onUnmatched?: OnUnmatched
  /** Set `false` when the Logfire token is read-only or code must not write variable metadata. */
  publishBaseline?: boolean
  /**
   * The instructions the agent declares in code.
   *
   * Two things depend on it, and both are about provenance. It tells a declared block from one a
   * `prepareCall`/`prepareStep` hook injected, which is what decides whether a block is addressable;
   * and it is the only evidence that a block's text is the agent's own rather than one request's
   * rendering, which is what decides whether that text may be published into the shared baseline.
   * Without it every block is published as a seam. `agentControl` passes the agent's own.
   */
  codeInstructions?: Instructions
  /**
   * The generation settings the agent declares in code.
   *
   * Used for precedence -- a request field that differs from this one was set for this run, and a
   * managed value does not overwrite it -- and for the baseline, so the Logfire editor is shown the
   * agent's own defaults rather than whatever the first request happened to carry. Without it a
   * managed setting wins over a per-call one, because by this point the two are indistinguishable.
   */
  codeSettings?: CallSettings
  /**
   * The specification version of the model this middleware is installed on.
   *
   * `wrapLanguageModel` accepts a v2, v3, or v4 model and bridges the older two with a `Proxy` whose
   * only behavior is to answer `'v4'` to `specificationVersion`, so a middleware cannot ask what it
   * is really talking to. It matters for exactly one setting: `reasoning` is the call option v4
   * added, and an older provider is handed it and drops it, so a published `thinking` has to be
   * reported rather than applied. `agentControl` reads it off the model it is given; a hand-rolled
   * `wrapLanguageModel` install on a pre-v4 model should pass it. Defaults to `'v4'`.
   */
  modelSpecificationVersion?: SpecificationVersion
}

/** One model request, as this middleware decided to make it. */
interface PreparedRequest {
  /** The call options to send, with every managed section applied. */
  params: LanguageModelV4CallOptions
  /** The model to send them to: the managed one where a config named one, else the wrapped one. */
  model: LanguageModelV4
  /** Advertised tool name to code-side name, for un-renaming what comes back. */
  routes: Record<string, string>
}

/**
 * Require a name rather than inventing one.
 *
 * The name is what picks the variable, so an agent that reaches Logfire under a name nobody chose is
 * worse than one that fails to start.
 */
export function requireName(name: string | undefined, hint: string): string {
  if (name === undefined || name.trim() === '') {
    throw new Error(
      'Logfire Agent Control needs an explicit agent name: it is what picks out the `agent__<name>` ' +
        `variable holding this agent's managed config. ${hint}`
    )
  }
  return name
}

/**
 * The middleware that applies an agent's managed config to every request through a model.
 *
 * The low-level install, for a `wrapLanguageModel` or `createProviderRegistry` call you already have.
 * `agentControl` is the same thing with the wrapping done for you, and with the agent's declared
 * instructions, settings, and model version filled in -- which is what buys the per-run precedence,
 * the publishable baseline text, and the reporting of a setting the model cannot honour that this
 * form has to be told about.
 *
 * ```ts
 * const model = wrapLanguageModel({
 *   model: anthropic('claude-fable-5-1'),
 *   middleware: agentControlMiddleware({ name: 'checkout_assistant' }),
 * });
 * ```
 */
export function agentControlMiddleware(options: AgentControlOptions): LanguageModelMiddleware {
  const name = requireName(options.name, 'Pass `name` to `agentControlMiddleware`, or use `agentControl` on an agent with an `id`.')
  const control = new AgentControl(name, {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.onUnmatched === undefined ? {} : { onUnmatched: options.onUnmatched }),
    ...(options.publishBaseline === undefined ? {} : { publishBaseline: options.publishBaseline }),
  })
  const onUnmatched = control.onUnmatched
  const resolveModel = createModelResolver(options, (message) => {
    control.reportUnmatched(message)
  })
  const declared = instructionMessages(options.codeInstructions)
  const wrappedVersion = options.modelSpecificationVersion ?? 'v4'
  // The baseline describes the agent as written only where the agent said what it is: with its own
  // instructions and its own settings in hand, every value published is one this adapter can point at
  // a line of code for. Without them it is a snapshot of whichever request happened to come first,
  // and the Logfire editor has to be told so rather than shown one run's temperature as a default.
  // The tool list is the request's either way -- the AI SDK resolves tool schemas on the way to a
  // model and a `prepareStep` can change the set per step -- which the README's limits say out loud.
  const baselineSource = options.codeInstructions !== undefined && options.codeSettings !== undefined ? 'code' : 'observed'

  // Learned from the first request when the agent did not declare its instructions; see
  // `CodeInstructions`.
  let code = declared.length > 0 ? CodeInstructions.declared(declared) : CodeInstructions.unknown()

  /** Publish the baseline once, then apply whatever the resolved config changes. */
  async function prepare(params: LanguageModelV4CallOptions, model: LanguageModelV4, config: AgentConfig | null): Promise<PreparedRequest> {
    const slots = systemSlots(params.prompt, code)
    code = code.learn(slots)

    const wrappedNamespace = providerNamespace(model.provider)
    control.publishBaseline(
      buildBaseline({
        // A block whose text is not provably the agent's own contributes its seam and not its text;
        // see `baselineBlockOf`.
        instructions: slots.map(baselineBlockOf),
        model: modelIdentifier(model),
        settings: canonicalSettings(options.codeSettings ?? params, wrappedNamespace, supportedSettings(wrappedNamespace, wrappedVersion)),
        tools: toolDefs(params.tools),
      }),
      { source: baselineSource }
    )

    if (config === null) {
      return { params, model, routes: {} }
    }

    const managed = config.model === undefined ? model : ((await resolveModel(config.model)) ?? model)
    noteModelSwap(managed, model)
    // The version of the model this request will actually reach: the one we resolved when a config
    // named one, and otherwise the wrapped model, whose real version only the caller could tell us.
    const version = managed === model ? wrappedVersion : managed.specificationVersion
    const { tools, routes, renames } = applyToTools(params.tools, config, onUnmatched)

    return {
      model: managed,
      routes,
      params: {
        ...params,
        prompt: renameHistory(
          writeSystemMessages(params.prompt, slots, applyInstructions(slots.map(blockOf), config, { onUnmatched }).blocks),
          renames
        ),
        ...(params.tools === undefined ? {} : { tools }),
        ...(params.toolChoice === undefined ? {} : { toolChoice: renameToolChoice(params.toolChoice, renames) }),
        ...lowerSettings(config, {
          params,
          code: options.codeSettings,
          namespace: providerNamespace(managed.provider),
          specificationVersion: version,
          onUnmatched,
        }),
      },
    }
  }

  return {
    wrapGenerate: async ({ params, model }): Promise<LanguageModelV4GenerateResult> =>
      control.run(async ({ config }) => {
        const request = await prepare(params, model, config)
        const result = await request.model.doGenerate(request.params)
        return { ...result, content: unrenameContent(result.content, request.routes) }
      }),

    wrapStream: async ({ params, model }): Promise<LanguageModelV4StreamResult> =>
      control.run(async ({ config }) => {
        const request = await prepare(params, model, config)
        const result = await request.model.doStream(request.params)
        const { routes } = request
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
              transform(part, controller) {
                controller.enqueue(unrenameStreamPart(part, routes))
              },
            })
          ),
        }
      }),
  }
}

/**
 * Note, once, that this process is running a model its code did not ask for.
 *
 * The wrapped model is not called at all when a managed one takes over -- but it is still what the
 * AI SDK reports as `modelId` on the span for the call, because `wrapLanguageModel` fixes that at
 * wrap time from a synchronous `overrideModelId`, and a managed value is only known once the
 * variable has resolved. Saying so once is better than a trace that names a model that never
 * answered and nothing to explain it.
 */
function noteModelSwap(managed: LanguageModelV4, wrapped: LanguageModelV4): void {
  if (managed.modelId === wrapped.modelId && managed.provider === wrapped.provider) {
    return
  }
  warnOnce(
    `Logfire Agent Control is running '${modelIdentifier(managed)}' in place of the code-defined ` +
      `'${modelIdentifier(wrapped)}'; AI SDK telemetry still reports the code-defined model, because the ` +
      "AI SDK fixes a wrapped model's reported id before the managed config is resolved."
  )
}
