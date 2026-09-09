/**
 * The Mastra processor that applies an agent's managed config.
 *
 * Mastra gives a processor two hooks that matter here, and the split between them is not a style
 * choice. `processInput` runs once per request and is the only one Mastra hands the `Agent` to, so it
 * is where the agent is read and where the variable is resolved -- once, so every step of a run sees
 * the same published value and the prompt prefix cannot change underneath a provider's cache.
 * `processInputStep` runs before every model call and is the only hook whose return value can replace
 * the system messages, the model, the tools and the settings, so it is where all four sections are
 * applied. The two share the per-request `state` bag Mastra threads between them.
 */

import { resolveModelConfig } from '@mastra/core/llm'
import type {
  InputProcessor,
  Processor,
  ProcessInputArgs,
  ProcessInputResult,
  ProcessInputStepArgs,
  ProcessInputStepResult,
} from '@mastra/core/processors'
import {
  AgentControl,
  applyInstructions,
  applySettings,
  applyToolDefinitions,
  buildBaseline,
  reportUnapplied,
  useResolution,
  warnOnce,
} from '@pydantic/logfire-node/agent-control'
import type { AgentConfig, OnUnmatched, Resolution } from '@pydantic/logfire-node/agent-control'

import { baselineBlocks, readCodeInstructions, requestBlocks, toSystemMessages, unaddressable } from './instructions'
import type { CodeInstructions, SystemMessage, Unaddressable } from './instructions'
import { honorsReasoning, isRoutableModelId, providerOf, toCanonicalModelId, toRouterModelId } from './model'
import { renamingModel, toolRenames } from './renaming'
import type { ResolvedModel } from './renaming'
import { lowerSettings, raiseSettings } from './settings'
import { applyToTools, readTools } from './tools'
import type { ToolRecord } from './tools'

/**
 * The agent as `processInput` hands one over.
 *
 * Read off the hook's own argument rather than written as `Agent<string>`, because Mastra's `Agent`
 * takes five type parameters and the hook is declared with the widest instantiation of them; naming
 * a narrower one here would only mean asserting the argument back into it at the call site.
 */
type MastraAgent = NonNullable<ProcessInputArgs['agent']>

/** The processor's id, which is also the key Mastra keeps its per-request state under. */
export const PROCESSOR_ID = 'logfire-agent-control'

/** Where the resolved session is kept in Mastra's per-processor, per-request `state` bag. */
const SESSION_KEY = 'session'

/** What is said about a published `instructions` section this request cannot address; see `unaddressable`. */
const UNADDRESSABLE: Record<Unaddressable, string> = {
  replaced:
    'Managed agent config publishes instructions, but this request passed its own `instructions:` ' +
    "option, which replaces the agent's blocks outright -- so the published ids no longer name the " +
    'blocks they were written against; that section is not applied.',
  duplicated:
    "Managed agent config publishes instructions, but two of this agent's own instruction blocks are " +
    'identical, and Mastra keeps only the first -- so every id after it would address a different ' +
    'block; that section is not applied. Give those blocks different text to make them addressable.',
}

/** Options for `agentControl`. */
export interface MastraAgentControlOptions {
  /**
   * The agent name that picks out the `agent__<name>` Logfire variable; defaults to the agent's `id`.
   *
   * Mastra's `id` is the agent's identity -- what its registry, its stored versions and its spans are
   * keyed by -- so it is the right default, and `name` is only a display name. Pass this to hold the
   * variable name steady across a rename of the agent, or to point two deployments at one config.
   */
  name?: string
  /** The label to read, or absent to let the variable's rollout choose one. */
  label?: string
  /** What to do with a published entry that reaches nothing: `'warn'` (default), `'ignore'`, `'error'`. */
  onUnmatched?: OnUnmatched
  /** Whether to publish the code-side baseline the Logfire editor shows; on by default. */
  publishBaseline?: boolean
}

/**
 * What one request resolved to, shared between the two hooks.
 *
 * `null` where the request has no agent to read, which is the one state in which this adapter cannot
 * say anything about the agent and therefore changes nothing about it.
 */
interface Session {
  control: AgentControl
  /** What the variable resolved to for this request: the config, and the label and version it came from. */
  resolution: Resolution
  /** The agent's instructions as written, or `null` when they are computed per request. */
  code: CodeInstructions | null
  /** The agent's configured model, for the baseline; not resolved, so a dynamic one is left unnamed. */
  modelConfig: unknown
  /** The published model as a router id, once it is known Mastra can resolve it. */
  routerModelId: string | undefined
  /** The agent's default model settings, which is what a value this run chose is recognised by differing from. */
  defaultModelSettings: Record<string, unknown> | undefined
  /** The agent's default provider options, read the same way and for the same two uses. */
  defaultProviderOptions: Record<string, Record<string, unknown>> | undefined
}

/**
 * Manage a Mastra agent's instructions, model, model settings and tool definitions from Logfire.
 *
 * ```ts
 * export const checkout = new Agent({
 *   id: 'checkout-assistant',
 *   name: 'Checkout Assistant',
 *   instructions: ['You are a concise checkout assistant.', 'Always confirm the order total.'],
 *   model: 'anthropic/claude-fable-5-1',
 *   tools: { getWeather },
 *   inputProcessors: [agentControl({ label: 'production' })],
 * });
 * ```
 *
 * The agent runs on its code until something is published for it, and goes on running on its code if
 * Logfire is unreachable, if the value does not validate, or if variables are switched off.
 */
export function agentControl(options: MastraAgentControlOptions = {}): InputProcessor {
  return new AgentControlProcessor(options)
}

/**
 * The processor `agentControl` returns; a class so both hooks share one options bag and one voice.
 *
 * Returned as Mastra's `InputProcessor` rather than as the wider `Processor`, because that is the
 * type `inputProcessors` accepts: it requires that at least one input hook actually be implemented.
 */
class AgentControlProcessor implements Processor {
  readonly id = PROCESSOR_ID
  readonly name = 'Logfire Agent Control'
  readonly description = "Applies the agent's Logfire-managed instructions, model, settings and tool definitions."

  readonly #options: MastraAgentControlOptions

  /**
   * One `AgentControl` per agent name, built on first use.
   *
   * A map rather than a field because one processor instance can be registered on more than one
   * agent, and each agent's config is its own variable. Reusing the control across requests is what
   * keeps the SDK's variable registration, its cache, and the once-per-process baseline publish
   * attached to the agent rather than to the request.
   */
  readonly #controls = new Map<string, AgentControl>()

  constructor(options: MastraAgentControlOptions) {
    this.#options = options
  }

  /**
   * Resolve the agent's config once for this request, and read the agent it belongs to.
   *
   * Everything that needs the `Agent` happens here, because this is the only hook Mastra passes it
   * to: the step hook is run by a processor runner built without one. Resolving here rather than per
   * step is also what keeps a run coherent -- a rollout that re-rolled between two steps of one run
   * would otherwise change the prompt mid-conversation.
   */
  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    args.state[SESSION_KEY] = await this.#open(args)
    return args.messageList
  }

  /**
   * Apply the resolved config to this step, and publish the baseline on the first one.
   *
   * Only the sections the published value actually carries are returned, and only when they change
   * something: a returned `modelSettings` replaces the step's whole settings object and a returned
   * tool record is re-prepared from scratch, so handing back an untouched copy would be work and
   * noise in the trace for nothing.
   */
  async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    const session = args.state[SESSION_KEY] as Session | null | undefined
    if (session === undefined) {
      // The step hook alone cannot do this: without the `Agent` there is no variable name to read,
      // no code-side instructions to address by id, and no defaults to tell a per-run setting from a
      // managed one. Mastra runs `processInput` before the first step of every agent request, so this
      // is a processor being run somewhere else -- a processor-only workflow -- rather than a fault.
      warnOnce(
        `Logfire Agent Control ran without the per-request state its \`processInput\` hook sets up, so this ` +
          'request runs on the code-defined agent. Register the processor on a Mastra `Agent` ' +
          '(`inputProcessors`), not on a processor-only workflow.'
      )
      return undefined
    }
    if (session === null) {
      return undefined
    }
    // One resolution for the whole request, and this is the work it drives: everything below --
    // including the baseline publish and every warning -- runs inside its telemetry context, so a
    // span opened here says which published version it was opened under.
    return await useResolution(session.resolution, async () => this.#apply(args, session))
  }

  /** Apply one request's resolved config to one step. */
  async #apply(args: ProcessInputStepArgs, session: Session): Promise<ProcessInputStepResult | undefined> {
    const systemMessages = args.systemMessages as SystemMessage[]
    const tools: ToolRecord = args.tools ?? {}
    const blocks = requestBlocks(systemMessages, session.code, args.messageList)
    const { definitions, reserved } = readTools(tools)

    // Published from the first step of the process, because that is the first moment the whole
    // picture exists: the agent's own text and model come from its configuration, but the tools the
    // model is actually offered are only assembled here. That is also why it is published as an
    // observation rather than as a description of the code -- the tool list is one request's, and a
    // request that carried a memory, workspace or MCP toolset assembles a different one. The core
    // publishes at most once per process.
    session.control.publishBaseline(
      buildBaseline({
        instructions: baselineBlocks(blocks, session.code),
        model: toCanonicalModelId(session.modelConfig) ?? null,
        settings: raiseSettings(session.defaultModelSettings, session.defaultProviderOptions, providerOf(session.modelConfig)),
        tools: definitions,
      }),
      { source: 'observed' }
    )

    const config = session.resolution.config
    if (config === null) {
      return undefined
    }
    const onUnmatched = session.control.onUnmatched
    const result: ProcessInputStepResult = {}

    if (config.instructions !== undefined) {
      // Where the request no longer starts with the code's own text, the published ids would address
      // blocks that are not the ones they name, so the whole section stands down -- and says so,
      // because a section that reaches nothing is exactly what `onUnmatched` is for.
      const skipped = session.code === null ? null : unaddressable(systemMessages, session.code)
      if (skipped === null) {
        const messages = toSystemMessages(applyInstructions(blocks, config, { onUnmatched }).blocks)
        if (differs(messages, systemMessages)) {
          result.systemMessages = messages
        }
      } else {
        session.control.reportUnmatched(UNADDRESSABLE[skipped])
      }
    }

    if (session.routerModelId !== undefined) {
      result.model = session.routerModelId
    }

    if (config.settings !== undefined) {
      // The model this step will actually use, which is the published one where there is one: the
      // settings that only exist as provider options have to be lowered for the provider being sent
      // to, not the one the code named.
      const model = session.routerModelId ?? args.model
      const lowered = lowerSettings(applySettings(config, { onUnmatched }), {
        provider: providerOf(model),
        supportsReasoning: honorsReasoning(model),
        modelSettings: {
          effective: args.modelSettings as Record<string, unknown> | undefined,
          defaults: session.defaultModelSettings,
        },
        providerOptions: {
          effective: args.providerOptions as Record<string, Record<string, unknown>> | undefined,
          defaults: session.defaultProviderOptions,
        },
      })
      reportUnapplied(lowered.unapplied, { onUnmatched })
      // Both come back as the whole object to send -- Mastra replaces rather than merges what a
      // processor returns -- or as `undefined` where the published value changed nothing. The casts
      // are the settings finding their way back into Mastra's own types: every key under them is one
      // of Mastra's, carrying either the value it already had or one the contract's schema validated.
      if (lowered.modelSettings !== undefined) {
        result.modelSettings = lowered.modelSettings as NonNullable<ProcessInputStepResult['modelSettings']>
      }
      if (lowered.providerOptions !== undefined) {
        result.providerOptions = lowered.providerOptions as NonNullable<ProcessInputStepResult['providerOptions']>
      }
    }

    if (config.tool_definitions !== undefined) {
      const applied = applyToolDefinitions(definitions, config, { onUnmatched, reserved, collisionScope: 'global' })
      const rebuilt = applyToTools(tools, definitions, applied.tools)
      if (rebuilt !== tools) {
        result.tools = rebuilt
      }
      const renames = toolRenames(definitions, applied)
      // A rename is the one overlay Mastra is not shown: the record keeps its code-side keys and the
      // model is wrapped instead, so the new name lives on the wire and nowhere else. Resolving the
      // model here is what Mastra would do with whatever this hook returns anyway -- its runner puts
      // every returned model through the same `resolveModelConfig` -- and a wrapped one has to be
      // resolved to be wrapped.
      if (renames.toModel.size > 0) {
        // The cast drops `resolveModelConfig`'s legacy v1 arm, which is not a model a step can run on
        // in the first place: Mastra's loop refuses one before it calls it.
        const model = (await resolveModelConfig(session.routerModelId ?? args.model)) as ResolvedModel
        result.model = renamingModel(model, renames, session.resolution)
      }
    }

    return result
  }

  /** Build this request's session, or `null` when there is no agent to build it from. */
  async #open(args: ProcessInputArgs): Promise<Session | null> {
    const agent = args.agent
    if (agent === undefined) {
      warnOnce(
        'Logfire Agent Control ran without an agent, so this request runs on the code-defined agent. ' +
          'Register the processor on a Mastra `Agent` (`inputProcessors`), not on a processor-only workflow.'
      )
      return null
    }

    const control = this.#control(this.#name(agent))
    const resolution = await control.resolution()
    recordResolution(args, control.variableName, resolution)

    // `__getOverridableFields` is Mastra's own accessor for the raw, unresolved values behind the
    // fields its editor can override -- the same three this adapter manages. It is the only way to
    // read them without invoking a dynamic one, and Mastra's stored-config editor reads them the same
    // way.
    const fields = agent.__getOverridableFields()
    const defaults = await agent.getDefaultOptions(requestContextOf(args))

    return {
      control,
      resolution,
      code: readCodeInstructions(fields.instructions),
      modelConfig: fields.model,
      routerModelId: this.#routerModelId(control, resolution.config),
      defaultModelSettings: defaults.modelSettings as Record<string, unknown> | undefined,
      defaultProviderOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
    }
  }

  /** The control backing one agent's variable, built once and reused for every request after. */
  #control(name: string): AgentControl {
    const existing = this.#controls.get(name)
    if (existing !== undefined) {
      return existing
    }
    const control = new AgentControl(name, {
      ...(this.#options.label === undefined ? {} : { label: this.#options.label }),
      ...(this.#options.onUnmatched === undefined ? {} : { onUnmatched: this.#options.onUnmatched }),
      ...(this.#options.publishBaseline === undefined ? {} : { publishBaseline: this.#options.publishBaseline }),
    })
    this.#controls.set(name, control)
    return control
  }

  /**
   * The published model as a router id, once it is one Mastra can resolve.
   *
   * A router id whose provider is not registered does not fail here: Mastra builds a model object for
   * it and fails at the request, which would take down every run the agent makes on the strength of
   * one published string. Reporting it and keeping the code-defined model is the behavior a managed
   * value has to degrade to.
   */
  #routerModelId(control: AgentControl, config: AgentConfig | null): string | undefined {
    if (config?.model === undefined) {
      return undefined
    }
    const routerModelId = toRouterModelId(config.model)
    if (isRoutableModelId(routerModelId)) {
      return routerModelId
    }
    control.reportUnmatched(
      `Managed agent config selects model '${config.model}', whose provider is not one Mastra's model router ` +
        'knows; that section is not applied and the agent keeps its code-defined model.'
    )
    return undefined
  }

  /** The name of the variable to read: the one given, else the agent's own id. */
  #name(agent: MastraAgent): string {
    // Typed as possibly absent on purpose: Mastra declares `id` as a string, but an agent built
    // without one carries `undefined` there, and that is the case this message exists for.
    const name: string | undefined = this.#options.name ?? (agent.id as string | undefined)
    if (name === undefined || name.trim() === '') {
      throw new Error(
        'Logfire Agent Control needs a name for this agent, which is what picks out the `agent__<name>` ' +
          'variable holding its managed config: give the Mastra agent an `id`, or pass ' +
          "`agentControl({ name: 'checkout_assistant' })`."
      )
    }
    return name
  }
}

/**
 * Note which published value drove this request, on the processor's own span.
 *
 * The core's `run()` would put the label on every span a run opens, as OpenTelemetry baggage -- but it
 * needs a scope to wrap, and a processor is a callback Mastra invokes rather than a scope around the
 * run. So the label and version are recorded where this adapter does have a span: its own. It is
 * enough to answer the question the baggage answers, which is which published version a trace ran on.
 */
function recordResolution(args: ProcessInputArgs, variableName: string, resolution: Resolution): void {
  args.tracingContext?.currentSpan?.update({
    metadata: {
      'logfire.agent_control': {
        variable: variableName,
        label: resolution.label,
        version: resolution.version,
        reason: resolution.reason,
      },
    },
  })
}

/** Mastra's `getDefaultOptions` takes a request context, and only when there is one to give. */
function requestContextOf(args: ProcessInputArgs): { requestContext: NonNullable<ProcessInputArgs['requestContext']> } | undefined {
  return args.requestContext === undefined ? undefined : { requestContext: args.requestContext }
}

/** Whether the applied messages are anything other than the ones that came in, by identity and length. */
function differs(applied: readonly SystemMessage[], original: readonly SystemMessage[]): boolean {
  return applied.length !== original.length || applied.some((message, index) => message !== original[index])
}
