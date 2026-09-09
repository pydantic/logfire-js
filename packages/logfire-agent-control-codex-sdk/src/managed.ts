/**
 * The adapter itself: the caller's Codex options in, the same options with the managed config
 * applied out.
 *
 * The Codex SDK is a wrapper around the `codex` binary, not an agent framework. There is no agent
 * object to patch, no tool registry, and no per-model-request hook to install: everything the model
 * sees is assembled inside the binary from `config.toml`, the `-c key=value` overrides the SDK
 * forwards, and files on disk. The only seam is therefore the options themselves, and the moment the
 * managed config can be applied is the moment a thread is started -- which is why this is a factory
 * over options rather than a middleware.
 *
 * That also fixes what is manageable. Instructions (the two writable blocks), the model, and the
 * reasoning effort lower onto real Codex knobs. Sampling settings and tool definitions have no
 * Codex-side equivalent at all, so a published value for them is reported rather than applied.
 */

import {
  AgentControl,
  applyInstructions,
  applySettings,
  buildBaseline,
  CANONICAL_SETTINGS_KEYS,
  mergeSettings,
  reportUnapplied,
  useResolution,
} from '@pydantic/logfire-node/agent-control'
import type { AgentConfig, AgentConfigSettings, OnUnmatched } from '@pydantic/logfire-node/agent-control'
import { Codex } from '@openai/codex-sdk'
import type { CodexOptions, ModelReasoningEffort, Thread, ThreadOptions } from '@openai/codex-sdk'

import { BASE_INSTRUCTIONS_ID, codeInstructions, foldInstructions, instructionBlocks, withInstructions } from './instructions'
import type { CodeInstructions } from './instructions'
import { joinModel, splitModel } from './model'

/**
 * The contract's `thinking` values, minus the `true`/`false` Codex has no meaning for.
 *
 * Every one of them is also a `ModelReasoningEffort`, which is why applying `thinking` needs no
 * translation table -- and if a later release of the contract adds a value Codex does not have, this
 * type stops assigning and the mismatch is a compile error rather than a bad `-c` flag.
 */
type ReasoningThinking = Exclude<NonNullable<AgentConfigSettings['thinking']>, boolean>

/**
 * The Codex reasoning efforts the contract has a `thinking` value for.
 *
 * The other direction, and partial in the other direction too: Codex's `max`, `ultra`, and
 * `persistent` have no `thinking` value, so an agent whose code asks for one of them keeps it and
 * simply does not publish it as a baseline -- publishing a value the stored schema rejects would put
 * an uneditable `settings` section in front of whoever opens the editor.
 */
const CONTRACT_THINKING: Partial<Record<ModelReasoningEffort, ReasoningThinking>> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
}

/** The Codex config key that names the provider a model slug is looked up under. */
const MODEL_PROVIDER_KEY = 'model_provider'
/** The Codex config key that names the model, for an agent that sets it there rather than per thread. */
const MODEL_KEY = 'model'
/** The Codex config key that names the reasoning effort, likewise. */
const MODEL_REASONING_EFFORT_KEY = 'model_reasoning_effort'

/** How a Codex agent's Agent Control is set up. */
export interface CodexAgentControlOptions {
  /**
   * The agent's name, which picks out the `agent__<name>` Logfire variable holding its config.
   *
   * Required and never inferred: Codex has no agent identity of its own to derive one from, and a
   * name that is guessed at is a name two agents can collide on. It is normalized to the variable
   * key by the core's one rule, so `ci_fixer` and `CI Fixer` are the same config.
   */
  name: string
  /** The options the code would have passed to `new Codex(...)`. */
  codex?: CodexOptions
  /** The options the code would have passed to `startThread(...)` / `resumeThread(...)`. */
  thread?: ThreadOptions
  /** Read this label instead of letting the variable's rollout choose one. */
  label?: string
  /** What to do about a published entry Codex has nowhere to put: `'warn'` (default), `'ignore'`, `'error'`. */
  onUnmatched?: OnUnmatched
  /** Whether to publish the code-side baseline to the variable's `example`. On by default. */
  publishBaseline?: boolean
}

/** Codex options with the managed config applied, ready to be handed to the SDK. */
export interface ManagedCodexConfiguration {
  /** What to pass to `new Codex(...)`. */
  codex: CodexOptions
  /** What to pass to `startThread(...)` or `resumeThread(...)`. */
  thread: ThreadOptions
}

/**
 * One Codex agent's options, managed from Logfire.
 *
 * ```ts
 * const managed = agentControl({
 *   name: 'ci_fixer',
 *   thread: { model: 'gpt-5.6-sol', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write' },
 *   codex: { config: { developer_instructions: 'Fix CI without changing public APIs.' } },
 * });
 * const answer = await managed.run(async (thread) => (await thread.run('Fix the failing job.')).finalResponse);
 * ```
 *
 * The published config is read once per thread, when the thread is started, because that is the last
 * moment Codex accepts any of it. A turn on an already-started thread runs with what its thread was
 * started with; start a new thread to pick up a change.
 *
 * `run(fn)` is the form to reach for: it starts the thread and holds the resolution's telemetry
 * context open for the whole callback, so the spans your code opens around the turn say which
 * published label drove it. `startThread` and `resumeThread` are the same application of the config
 * without that scope -- they return an object, so the context is closed by the time you use it --
 * and `resolveOptions` is the way out for code that builds its own `Codex`.
 */
export class ManagedCodex {
  /** The Logfire variable behind this agent, exposed for its `name`, `label`, and `onUnmatched`. */
  readonly control: AgentControl

  readonly #codex: CodexOptions
  readonly #thread: ThreadOptions
  readonly #code: CodeInstructions

  constructor(options: CodexAgentControlOptions) {
    const { name } = options
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(
        '`agentControl` needs an explicit `name`: it is what picks out the `agent__<name>` Logfire variable ' +
          "holding this agent's managed config, and Codex has no agent name of its own to derive one from."
      )
    }
    this.control = new AgentControl(name, {
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.onUnmatched === undefined ? {} : { onUnmatched: options.onUnmatched }),
      ...(options.publishBaseline === undefined ? {} : { publishBaseline: options.publishBaseline }),
    })
    this.#codex = options.codex ?? {}
    this.#thread = options.thread ?? {}
    this.#code = codeInstructions(options.codex, options.thread)
    // Everything a Codex agent is, it is at construction: there is no request to wait for and no
    // tool list to discover, so the baseline is complete now and the Logfire editor can have it
    // before the first run rather than after it. `'code'` and not `'observed'` for the same reason
    // -- it is read off the options the code passes, not off a request that happened first.
    this.control.publishBaseline(this.baseline(), { source: 'code' })
  }

  /**
   * The `AgentConfig` describing this agent as its code defines it.
   *
   * Published to the variable's `example`, which is what the Logfire editor shows a managed value
   * being layered onto. Only the blocks whose text this adapter actually knows carry any: Codex's
   * built-in prompt, its skills, its permissions preamble, the `AGENTS.md` chain, and the
   * environment context are assembled inside the binary, so they are published as seams -- and the
   * built-in prompt is not published at all, since an empty box labelled `base_instructions` is an
   * invitation to replace the instructions that tell Codex how to use its own tools.
   *
   * The model and the reasoning effort are read wherever the code sets them: `ThreadOptions` first,
   * because the SDK sends `thread.model` as `--model` and its effort as the last `-c` flag, both of
   * which beat the `config` keys; and `codex.config` otherwise, which is how an agent that pins its
   * model once for every thread writes it. What is *not* read is the machine's `config.toml`, so an
   * agent whose code names no model publishes none rather than a guess.
   *
   * There is no `tool_definitions` section, because Codex's tools are defined in the binary and this
   * adapter cannot see or change them.
   */
  baseline(): AgentConfig {
    const model = this.#codeModel()
    const thinking = contractThinking(this.#codeReasoningEffort())
    return buildBaseline({
      instructions: instructionBlocks(this.#code),
      ...(model === undefined ? {} : { model: joinModel({ model, provider: this.#codeProvider() }) }),
      settings: thinking === undefined ? {} : { thinking },
    })
  }

  /**
   * The caller's options with the published config applied.
   *
   * `overrides` are `ThreadOptions` for this thread only, and they win over the published config,
   * which wins over the options this `ManagedCodex` was built with. Per-call values beating a
   * managed value is the contract's precedence rule, and it is what keeps a `workingDirectory` or a
   * `signal` computed per call from being second-guessed by something published a week ago.
   *
   * The resolution's telemetry context covers the application of the config and closes when this
   * returns, because what comes back is an object rather than a scope; `run` is the form whose
   * context covers the turn itself.
   *
   * When the agent is running on code -- nothing published, Logfire unreachable, variables switched
   * off -- the caller's own options come back merged with `overrides` and nothing else, so a Logfire
   * outage is indistinguishable from this package not being installed.
   */
  async resolveOptions(overrides: ThreadOptions = {}): Promise<ManagedCodexConfiguration> {
    const resolution = await this.control.resolution()
    // Resolved once and installed for the work that reads it, rather than resolved again inside it:
    // the config applied and the label its warnings and spans carry are then the same one.
    return useResolution(resolution, () => this.#apply(resolution.config, overrides))
  }

  /**
   * Start a thread with the published config applied and run `fn` with it, inside the resolution's
   * telemetry context.
   *
   * The form to reach for when the whole thread is a unit you can wrap, because every span opened
   * inside `fn` carries the label the config was resolved under. A `codex` child process is not
   * something this package can instrument, but the spans your own code opens around a turn are, and
   * they are what tell "this agent regressed" apart from "this agent regressed on the value someone
   * published at 14:02".
   *
   * ```ts
   * const answer = await managed.run(async (thread) => (await thread.run('Fix the failing job.')).finalResponse);
   * ```
   *
   * The `thread` is the SDK's own, so a second `thread.run(...)` inside `fn` is a second turn on the
   * options this one resolved; call `run` again for a thread that reads the config again.
   */
  async run<T>(fn: (thread: Thread) => Promise<T>, overrides: ThreadOptions = {}): Promise<T> {
    return this.control.run(async ({ config }) => {
      const { codex, thread } = this.#apply(config, overrides)
      return fn(new Codex(codex).startThread(thread))
    })
  }

  /**
   * The pure half of `resolveOptions`: one resolved config, applied to the caller's options.
   *
   * Separate so `run` can apply the config it was handed *inside* the resolution's context instead of
   * resolving a second time and possibly getting a different label.
   */
  #apply(config: AgentConfig | null, overrides: ThreadOptions): ManagedCodexConfiguration {
    if (config === null) {
      // `config` is copied too, not just the options object around it. The managed path below builds
      // a fresh one, and a caller that edits what it got back must not be editing this agent's own
      // options on the run where nothing was published either.
      const codex: CodexOptions = { ...this.#codex }
      if (codex.config !== undefined) {
        codex.config = { ...codex.config }
      }
      return { codex, thread: { ...this.#thread, ...overrides } }
    }
    const onUnmatched = this.control.onUnmatched

    const applied = foldInstructions(applyInstructions(instructionBlocks(this.#code), config, { onUnmatched }).blocks)
    if (applied.base === null) {
      // Removing this block stops *this* package from replacing Codex's system prompt, which is as
      // far as the CLI lets it go: there is no `-c` value that resets `model_instructions_file`, and
      // an empty one is a path Codex fails the run trying to read.
      this.control.reportUnmatched(
        `Managed agent config removes instruction block '${BASE_INSTRUCTIONS_ID}'. This agent stops replacing ` +
          "Codex's built-in system prompt, but Codex has no config key that resets one, so a " +
          "'model_instructions_file' in the machine's own config.toml would still replace it."
      )
    }
    const codex: CodexOptions = { ...this.#codex, config: withInstructions(this.#codex.config, applied, this.#code) }

    const settings = applySettings(config, { onUnmatched })
    const published: ThreadOptions = {}
    if (config.model !== undefined) {
      published.model = splitModel(config.model).model
    }
    if (typeof settings.thinking === 'string') {
      published.modelReasoningEffort = settings.thinking
    }
    // The contract's precedence, from the core rather than from a spread, because the answer to
    // "who set this" is what the model provider below turns on: `overrides` are the keys this call
    // set explicitly, so a run that picks its own model is telling this adapter something a run that
    // inherited one is not.
    const merged = mergeSettings(this.#thread, published, overrides)
    // A cast because `mergeSettings` is framework-neutral and hands back a flat record; every key in
    // it came from a `ThreadOptions` this method was given or wrote.
    const thread = merged.settings as ThreadOptions

    // The provider travels with the model it qualifies, and only with it. A published
    // `openai:gpt-5.6-sol` that lost the model to an explicit per-thread one must not leave its
    // `model_provider` behind, or this call sends the caller's model to somebody else's endpoint.
    if (config.model !== undefined && merged.sources.get('model') === 'published') {
      // Left alone when the published model names no provider, so an agent pointed at a self-hosted
      // provider in `config.toml` keeps it when someone publishes only a model slug.
      const { provider } = splitModel(config.model)
      if (provider !== undefined) {
        codex.config = { ...codex.config, [MODEL_PROVIDER_KEY]: provider }
      }
    }

    // Everything else the contract can carry -- the sampling settings, `max_tokens`, `timeout`,
    // `parallel_tool_calls`, and a `thinking` of `true`/`false` -- has no Codex config key at all,
    // so it is reported rather than quietly dropped. Codex is a coding-agent runtime: what it
    // exposes is reasoning effort, not a sampler.
    reportUnapplied(unapplicableSettings(settings), { onUnmatched })
    // Codex's tools are defined inside the binary and are never sent by a client, so there is no
    // list to patch and no rename to route back -- and saying that outright is better than letting a
    // match against an empty tool list report it as a tool this deployment happens not to advertise.
    for (const override of config.tool_definitions ?? []) {
      this.control.reportUnmatched(
        `Managed agent config patches tool '${override.name}', which Codex defines inside its own binary; ` +
          "a Codex tool's name, description, and parameters cannot be managed from Logfire."
      )
    }

    return { codex, thread }
  }

  /** Start a Codex thread with the published config applied; see `resolveOptions`. */
  async startThread(overrides: ThreadOptions = {}): Promise<Thread> {
    const { codex, thread } = await this.resolveOptions(overrides)
    return new Codex(codex).startThread(thread)
  }

  /**
   * Resume a Codex thread with the published config applied; see `resolveOptions`.
   *
   * The overrides are re-sent as `-c` flags on the `codex exec resume` process, and Codex takes some
   * of them and not others. A published model and reasoning effort apply to the resumed turn; a
   * changed developer block does **not** -- the binary replays the developer message it persisted
   * with the session, and the flag is ignored. Both observed against codex-cli 0.153.4 and pinned by
   * `live-tests/codex.live.ts`. So a published instruction change is something new threads pick up.
   */
  async resumeThread(id: string, overrides: ThreadOptions = {}): Promise<Thread> {
    const { codex, thread } = await this.resolveOptions(overrides)
    return new Codex(codex).resumeThread(id, thread)
  }

  /** The model slug the code runs on, from whichever of the two places it set one. */
  #codeModel(): string | undefined {
    return this.#thread.model ?? stringOf(this.#codex.config?.[MODEL_KEY])
  }

  /** The reasoning effort the code runs on, likewise. */
  #codeReasoningEffort(): string | undefined {
    return this.#thread.modelReasoningEffort ?? stringOf(this.#codex.config?.[MODEL_REASONING_EFFORT_KEY])
  }

  /** The provider id the code pins, if it pins one. */
  #codeProvider(): string | undefined {
    return stringOf(this.#codex.config?.[MODEL_PROVIDER_KEY])
  }
}

/**
 * Manage a Codex agent's instructions, model, and reasoning effort from Logfire.
 *
 * A function rather than a bare `new` so the one line a user adds reads like the SDK's own idiom;
 * see `ManagedCodex`.
 */
export function agentControl(options: CodexAgentControlOptions): ManagedCodex {
  return new ManagedCodex(options)
}

/** The contract's `thinking` value for a Codex reasoning effort, when it has one. */
function contractThinking(effort: string | undefined): ReasoningThinking | undefined {
  // Looked up by iteration rather than by index so a value read out of a `config.toml`-shaped object
  // -- an arbitrary string -- can be matched against the table without being asserted into its key
  // type first, and so the table itself keeps the exhaustiveness check that makes a new contract
  // value a compile error.
  return Object.entries(CONTRACT_THINKING).find(([codex]) => codex === effort)?.[1]
}

/** A Codex config value when it is a string, which is all a model or provider id can be. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The canonical settings a published value set that Codex has no knob for. */
function unapplicableSettings(settings: AgentConfigSettings): string[] {
  return CANONICAL_SETTINGS_KEYS.filter(
    (key) => settings[key] !== undefined && !(key === 'thinking' && typeof settings.thinking === 'string')
  )
}
