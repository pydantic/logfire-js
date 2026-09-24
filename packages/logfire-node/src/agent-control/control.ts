/**
 * The variable behind one agent's managed config: reading the published value, reporting the
 * baseline.
 *
 * Everything remote lives here. The helpers in `./instructions.ts`, `./tools.ts`, `./settings.ts`,
 * and `./baseline.ts` are pure, so an adapter's tests never need a provider, and this class is the
 * only thing that has to know a Logfire project exists.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { defineVar, ResolvedVariable, Variable } from 'logfire/vars'
import type { VariableResolutionReason } from 'logfire/vars'

import { parseAgentConfig } from './config'
import type { AgentConfig } from './config'
import { reportConfigHint, resetConfigHintGuard } from './hint'
import type { BaselinePublication, BaselineSource } from './hint'
import { agentVariableName } from './names'
import { AGENT_CONFIG_JSON_SCHEMA } from './schema'
import { reportIssues, reportUnmatched as report, warnOnce } from './warnings'
import type { ApplyIssue, OnUnmatched } from './warnings'

export type { BaselinePublication, BaselineSource } from './hint'

/**
 * The resolution outcomes that mean a published value was actually applied.
 *
 * Every other reason -- no provider configured, no such variable, nothing targeted at this label, a
 * value that failed validation, a provider that could not be reached -- means the agent runs on
 * code, which `resolve` reports as `null` rather than as an empty config, so an adapter can tell
 * "managed, and it says change nothing" apart from "not managed".
 */
const APPLIED_REASONS = new Set(['resolved', 'context_override'])

/**
 * Resolution outcomes worth saying something about.
 *
 * A variable that does not exist yet is the normal state of an agent nobody has configured, and a
 * provider that is switched off is a deliberate choice; neither is news. A validation failure or an
 * unreachable provider is: the agent is running on code while Logfire holds a value someone expects
 * it to be running on.
 */
const NOTEWORTHY_REASONS = new Set(['validation_error', 'other_error'])

/**
 * Variables built in this process, by variable name.
 *
 * `defineVar` registers a variable in the SDK's module-level registry -- which is what puts it in
 * `logfire vars push` -- and refuses a name that is already registered. Two `AgentControl`s for one
 * agent is a perfectly ordinary thing for an adapter to end up with, and they should share one
 * variable rather than the second one throwing, so the map is what makes the registration happen
 * once.
 */
const variables = new Map<string, Variable<AgentConfig>>()

/** Options for `AgentControl.reportBaseline`. */
export interface ReportBaselineOptions {
  /**
   * Whether the baseline describes the agent as written or one request that happened to come first.
   *
   * An adapter that reads its framework's agent object leaves this at `'code'`. One whose framework
   * assembles its prompt or tool list from callables, so that the earliest anything can be read is a
   * request, passes `'observed'` and says so, rather than letting a snapshot of one request stand in
   * for a description of the code. A new process reports again, so a changed deployment updates
   * either kind. It also chooses how much of the baseline is reported by default; see
   * `AgentControlOptions.reportBaseline`.
   */
  source?: BaselineSource
}

/**
 * Which Agent Control SDK a hint came from when nobody said.
 *
 * The core is framework-neutral, so an application driving it directly is not using a framework at
 * all, and naming one would be a guess. What a consumer actually needs from the attribute is whose
 * baseline it is reading -- the ids a baseline addresses its instruction blocks by are each
 * implementation's own -- and for an adapterless agent that answer is this package.
 */
const DEFAULT_FRAMEWORK = 'logfire-node'

/**
 * What one resolution of an agent's variable came back with.
 *
 * All four together, because an adapter needs more than the value: the `label` and `version` are what
 * put a run's telemetry next to the thing someone saved in Logfire, and the `reason` is what tells
 * "Logfire says change nothing" apart from "Logfire was never asked" when both hand back a `null`
 * config.
 */
export interface Resolution {
  /**
   * The published config, or `null` when the agent is running on code.
   *
   * `null` rather than an empty config, so an adapter can tell a value that deliberately changes
   * nothing apart from there being no value at all.
   */
  config: AgentConfig | null
  /**
   * The Logfire variable this was read from, which is also the key its scope is held under.
   *
   * `useResolution` and `currentResolution` are keyed on it, so a resolution carries the name of the
   * agent it belongs to rather than an adapter having to pair the two up itself.
   */
  variableName: string
  /** The label resolution selected, or `null` when none was. */
  label: string | null
  /** The version of that label's value, or `null` when nothing was resolved. */
  version: number | null
  /**
   * How resolution ended.
   *
   * One of the Logfire SDK's `VariableResolutionReason` values, typed as `string` so a reason a newer
   * SDK adds is something an adapter can log rather than something that fails its build.
   *
   * `'resolved'` and `'context_override'` are the two that mean `config` is non-`null`. Everything
   * that means "running on code" reports `'code_default'` -- no provider configured, no such
   * variable, and a variable with nothing targeted all land there, because to an agent they are one
   * outcome -- except the two that are worth knowing about: `'validation_error'` for a value that
   * would not parse and `'other_error'` for a provider that could not be reached, both of which also
   * warn once per process.
   */
  reason: string
}

/** Options for `AgentControl`. */
export interface AgentControlOptions {
  /**
   * The label to read, or absent to let the variable's rollout choose one.
   *
   * A deployment that pins a label is saying "this process runs the `production` value" regardless
   * of what the rollout would have picked, which is how a staging deployment reads a staging value
   * without a targeting rule.
   */
  label?: string
  /**
   * What to do with a published entry that reaches nothing.
   *
   * Applied by `report`, which is the one place it is applied: the `apply*` helpers plan a request
   * and hand back what they could not apply, so an adapter reports every section's issues together
   * and `'error'` names all of them.
   */
  onUnmatched?: OnUnmatched
  /**
   * Which Agent Control SDK produced this agent's hints, as `agent_control.framework` reports it.
   *
   * An adapter names its framework -- `'pydantic-ai'`, `'mastra'` -- because the ids a baseline
   * addresses its instruction blocks by are each implementation's own, so a consumer has to know
   * whose baseline it is reading. An application driving this core directly has no framework to name
   * and can leave it alone; see `DEFAULT_FRAMEWORK`.
   */
  framework?: string
  /**
   * How much of the code baseline leaves this process on the hint span; see `BaselinePublication`.
   *
   * Defaults to `'structure'` when the baseline was `'observed'` and `'text'` when it was read off
   * the code, which is where the two differ: code-side text is the author's, written knowing it is
   * editable from this Logfire project, while text snapshotted from a request is whoever's request it
   * happened to be. Set it explicitly to hold a code-side baseline to its seams as well, which is what
   * a deployment whose prompts are not for every member of its Logfire project wants.
   */
  reportBaseline?: BaselinePublication
}

/**
 * Manage one agent's config through one `agent__<name>` Logfire variable.
 *
 * The variable holds an `AgentConfig`. Each present section -- `instructions`, `model`, `settings`,
 * or `tool_definitions` -- is managed from Logfire, while an absent section keeps the code-defined
 * behavior. Removing a section in Logfire is a deliberate revert to code.
 *
 * ```ts
 * const control = new AgentControl('checkout_assistant', { label: 'production' });
 *
 * return await control.run(async (resolution) => {
 *   const { config } = resolution;
 *   control.reportBaseline(buildBaseline({ instructions: codeBlocks, model, tools }), resolution);
 *   const blocks = config === null ? codeBlocks : applyInstructions(codeBlocks, config).blocks;
 *   return runTheAgent(blocks);
 * });
 * ```
 *
 * Nothing here ever creates or updates a Logfire variable. An agent reports its code baseline on a
 * span and Logfire promotes that into a config when someone asks it to; `logfire vars push` is how a
 * deployment creates one from code deliberately.
 *
 * Everything inside `run` carries the resolved label on its spans, so a trace says which published
 * version drove it. `resolution()` and `resolve()` are there for an adapter whose framework gives it
 * no single scope to wrap.
 *
 * The agent name is required and never inferred. The reference implementation can derive one from a
 * framework's own agent name, and that derivation is lossy -- `checkout-assistant` and
 * `checkout_assistant` normalize onto the same variable -- so a core that has no framework to ask
 * takes the name it will use rather than guessing at one.
 */
export class AgentControl {
  /**
   * The agent's name as given, trimmed, which is what telemetry and the Logfire UI display.
   *
   * Kept verbatim otherwise -- punctuation and capitals and all -- because it is what a person
   * recognizes the agent by. The variable is keyed on `variableName`, which is this name normalized,
   * so the display name can be changed to read better without moving the agent to a different config,
   * as long as it still normalizes to the same key.
   */
  readonly name: string
  /** The Logfire variable holding the config: `agent__` plus the normalized name. */
  readonly variableName: string
  /** The label this control reads, or `undefined` to let the rollout choose. */
  readonly label: string | undefined
  /** The policy `report` applies to a request's issues; see `OnUnmatched`. */
  readonly onUnmatched: OnUnmatched

  /** Which Agent Control SDK this agent's hints report; see `AgentControlOptions.framework`. */
  readonly framework: string

  readonly #reportBaseline: BaselinePublication | undefined
  readonly #variable: Variable<AgentConfig>

  constructor(name: string, options: AgentControlOptions = {}) {
    // Before anything is assigned, because a name with nothing to key on is not an agent this class
    // can back: `agentVariableName` throws, naming the rule and what it needs.
    this.variableName = agentVariableName(name)
    this.name = name.trim()
    this.label = options.label
    this.onUnmatched = options.onUnmatched ?? 'warn'
    this.framework = options.framework ?? DEFAULT_FRAMEWORK
    // Left undefined rather than defaulted here: what it defaults to depends on the `source` of the
    // baseline, which is not known until one is reported.
    this.#reportBaseline = options.reportBaseline
    this.#variable = agentVariable(this.variableName)
  }

  /**
   * Resolve the variable and report what came back, whether or not anything was published.
   *
   * The full outcome, not just the value: which `label` was selected, which `version` of it, and the
   * `reason` resolution ended on. An adapter wants all four together -- to put the label and version
   * on its own telemetry, and to tell "Logfire says change nothing" apart from "Logfire was never
   * asked" when both hand back a `null` config.
   *
   * Never throws on a network problem, a missing variable, or a value that fails validation: all
   * three mean the agent keeps running exactly as its code defines it, which is the behavior a
   * managed config has to degrade to if it is going to be safe to depend on. That is the SDK's
   * contract and not a guard here -- resolution reports a failed read, a thrown read, and a provider
   * missing the method entirely as a `reason`, never as a rejection -- so there is deliberately no
   * `catch` around it to go stale and never run. The two reasons worth knowing about, a value that
   * would not validate and a provider that could not be reached, warn once per process.
   *
   * The value is parsed leniently, so what comes back may be less than what was published: a
   * malformed setting or an unparseable tool override is dropped, with a warning naming it, while
   * its siblings apply. A parse never fails as a whole, so a value that reaches here is never lost to
   * one bad field.
   */
  async resolution(): Promise<Resolution> {
    return (await this.#resolve()).resolution
  }

  /**
   * The published config for this agent, or `null` when it is running on code.
   *
   * Sugar over `resolution()` for an adapter that only wants the value; identical in every other
   * respect, including the warnings.
   */
  async resolve(): Promise<AgentConfig | null> {
    return (await this.resolution()).config
  }

  /**
   * Resolve once, then run `fn` with the outcome inside the resolution's telemetry context.
   *
   * This is the form to reach for when the agent run is a unit you can wrap, because it fixes
   * something `resolve()` cannot: every span the callback opens carries the selected label as
   * OpenTelemetry baggage, under the SDK's own `logfire.variables.<variable name>` key (with
   * `<code_default>` when nothing was selected). So a trace says which published version the run was
   * actually driven by, which is the difference between "this agent regressed" and "this agent
   * regressed on the value someone saved at 14:02".
   *
   * The baggage is the Logfire SDK's mechanism, not one invented here: it is
   * `ResolvedVariable.withContext`, the same entry the SDK writes for any managed variable, so a
   * project's existing baggage configuration picks it up with nothing further to set. The `version`
   * is reported on the `Resolution` rather than as a second baggage key, because a key no other
   * Logfire SDK writes is one nothing else would know to read.
   *
   * One resolve serves the whole callback: the config `fn` is handed and the label the spans carry
   * cannot disagree, however long the run lasts or how many times a rollout would have re-rolled.
   */
  async run<T>(fn: (resolution: Resolution) => Promise<T>): Promise<T> {
    const { resolved, resolution } = await this.#resolve()
    // The scope as well as the telemetry context: an adapter whose framework hands it a second hook
    // inside this callback reads `control.currentResolution()` there and gets this one resolution,
    // rather than resolving again and risking prompt A with model B.
    return scope.run(new Map(scope.getStore()).set(this.variableName, resolution), async () =>
      resolved.withContext(async () => fn(resolution))
    )
  }

  /**
   * Apply this control's `onUnmatched` policy to everything one request could not apply.
   *
   * The `apply*` helpers plan and report nothing; this is where the policy the user configured is
   * applied, once, to every section at once. Which is what makes their return value load-bearing: an
   * adapter that plans three sections and forgets to report says nothing, visibly, rather than
   * duplicating a warning that was already emitted.
   *
   * ```ts
   * const instructions = applyInstructions(blocks, config);
   * const tools = applyToolDefinitions(request.tools, config, { reserved });
   * const settings = applySettings(config, { support: SUPPORT });
   * control.report(...instructions.issues, ...tools.issues, ...settings.issues);
   * ```
   *
   * Reporting after everything is planned is the point of collecting them: `'error'` used to throw
   * inside the first section's apply call, so the strictest policy reported the least -- the other
   * sections were never planned and their issues were never returned. One call throws one
   * `UnmatchedConfigError`, naming every issue and carrying them on `issues`, which is what lets an
   * adapter translate it into its own framework's error type without restating a message.
   */
  report(...issues: readonly ApplyIssue[]): void {
    reportIssues(this.onUnmatched, issues)
  }

  /**
   * Report something this adapter could not apply, as a message.
   *
   * `report` is the channel for anything the core planned, and anything an adapter can describe as an
   * `ApplyIssue` -- including a section it cannot reach (`'unsupported-section'`) and a setting its
   * provider dropped (`droppedByProvider`). This is the same policy for a message with no path to
   * give, and applies it on its own so a message is not held back waiting for a request's other
   * sections.
   *
   * Write the message the way the built-in ones read: name what was published, and say what did not
   * happen to it. `'warn'` deduplicates it per process, so it is safe to call per request.
   */
  reportUnmatched(message: string): void {
    report(this.onUnmatched, message)
  }

  /**
   * Resolve the backing variable once, keeping the SDK's own object alongside the flat outcome.
   *
   * `run` needs the `ResolvedVariable` itself for its baggage context, and `resolution` needs only
   * the flat shape; doing both from one place is what stops the two from ever resolving twice and
   * disagreeing.
   */
  async #resolve(): Promise<{ resolved: ResolvedVariable<AgentConfig>; resolution: Resolution }> {
    const resolved: ResolvedVariable<AgentConfig> = this.#pinned(
      await this.#variable.get(this.label === undefined ? {} : { label: this.label })
    )
    const applied = APPLIED_REASONS.has(resolved.reason)
    if (!applied && NOTEWORTHY_REASONS.has(resolved.reason)) {
      warnOnce(
        `Logfire managed variable '${this.variableName}' could not be resolved (${resolved.reason}); ` +
          'running on the code-defined agent.'
      )
    }
    return {
      resolved,
      resolution: {
        config: applied ? resolved.value : null,
        variableName: this.variableName,
        label: resolved.label ?? null,
        version: resolved.version ?? null,
        reason: resolved.reason,
      },
    }
  }

  /**
   * Hold a pinned label to what it says, discarding a value the SDK resolved under another one.
   *
   * A label with nothing published does not stay pinned on the way down: `Variable.get` retries the
   * read without the label and hands back whatever the rollout would have picked, so a control pinned
   * to `staging` comes back holding `production`'s value under `reason: 'resolved'` -- applied, and
   * reported as `production` by a control the deployment pinned to `staging`.
   *
   * Pinning a label is a statement about which value this process runs, so another label's value is
   * not this control's value. It is the "nothing targeted at this label" outcome named in
   * `APPLIED_REASONS`, and it lands where every one of those lands: the agent runs on code. Returned
   * as a fresh code-default `ResolvedVariable` rather than by nulling the flat fields, so `run`'s
   * baggage says `<code_default>` too and a span cannot be tagged with a label whose value the run
   * never saw.
   *
   * Worth one warning: unlike a variable nobody has configured, someone wrote this label into a
   * deployment and expects the agent to be running what is under it.
   */
  #pinned(resolved: ResolvedVariable<AgentConfig>): ResolvedVariable<AgentConfig> {
    if (this.label === undefined || resolved.label === undefined || resolved.label === this.label) {
      return resolved
    }
    warnOnce(
      `Logfire managed variable '${this.variableName}' has nothing published under the pinned label ` +
        `'${this.label}'; the project resolved '${resolved.label}' instead, which this control does not ` +
        'apply. Running on the code-defined agent.'
    )
    return new ResolvedVariable<AgentConfig>({
      name: this.variableName,
      reason: 'code_default',
      value: {} as AgentConfig,
    })
  }

  /**
   * Report the code baseline for this agent, once per process, on one hint span.
   *
   * This is how an agent gets a managed config, and how it stays accurate once it has one. **Nothing
   * here writes a variable.** Every agent reports what it says in code, and Logfire turns that into a
   * config for an agent it has none for, or offers to refresh a stored baseline the code has moved on
   * from -- on a person's click, which is what keeps a managed config something someone decided to
   * have rather than something a deployment made for them. The span carries the whole contract; see
   * `reportConfigHint` for every attribute on it.
   *
   * Reported whether or not a config resolved, which is what makes the second half possible: an agent
   * that reported only while unconfigured would go quiet the moment someone configured it, and its
   * stored baseline would describe the code as it was that day. `resolution.reason` is what tells the
   * two apart on the span, which is why the run's resolution is a parameter rather than something
   * this resolves for itself -- a second resolve could disagree with the one the run is using, and
   * would report a version the agent never ran on.
   *
   * At most once per process per destination, and the guard is marked *before* the work, so
   * concurrent first requests cannot report twice. That is also what makes the caller's job easy:
   * call it on every request and let this decide.
   *
   * ```ts
   * await control.run(async (resolution) => {
   *   control.reportBaseline(buildBaseline({ instructions: codeBlocks, model, tools }), resolution);
   *   // ...
   * });
   * ```
   *
   * Never throws. It is called from the middle of an agent run, and describing the agent must not be
   * what takes that run down -- so a baseline that will not serialize at all warns once and reports
   * nothing, rather than reaching the caller.
   *
   * @param baseline What to report, from `buildBaseline`.
   * @param resolution The run's resolution, from `run`, `resolution()`, or `currentResolution()`.
   * @param options `source` says whether `baseline` describes the agent as written or one request
   * that happened to come first; see `BaselineSource`.
   */
  reportBaseline(baseline: AgentConfig, resolution: Resolution, options: ReportBaselineOptions = {}): void {
    const source = options.source ?? 'code'
    try {
      reportConfigHint({
        variableName: this.variableName,
        agentName: this.name,
        framework: this.framework,
        source,
        resolutionReason: resolution.reason,
        baseline,
        // The source is what decides this when nobody said: see `AgentControlOptions.reportBaseline`.
        publication: this.#reportBaseline ?? (source === 'observed' ? 'structure' : 'text'),
      })
    } catch (error) {
      // Describing the agent is not supposed to be able to fail -- `buildBaseline` produces a plain
      // JSON document -- but an adapter may hand in an `AgentConfig` it assembled itself, and a value
      // `JSON.stringify` refuses is the one way that goes wrong. A run keeps running.
      warnOnce(`Failed to report the code baseline for Logfire managed variable '${this.variableName}': ` + describe(error))
    }
  }

  /**
   * This agent's resolution for the surrounding run scope, or `null` outside one.
   *
   * Sugar over `currentResolution` for this control's own variable, which is what an adapter almost
   * always wants: it holds the control already, and it should not have to know that the scope is keyed
   * on a variable name.
   */
  currentResolution(): Resolution | null {
    return currentResolution(this.variableName)
  }
}

/**
 * The resolutions in scope, per variable, for the current asynchronous execution.
 *
 * A `Map` rather than one value because agents nest: a handoff, a subagent, or a tool that runs
 * another managed agent puts a second control's scope inside the first, and `currentResolution` for
 * either of them has to keep answering about *that* one rather than about whichever was entered last.
 */
const scope = new AsyncLocalStorage<ReadonlyMap<string, Resolution>>()

/**
 * Make one resolution the answer for its agent, and report it, for the whole of `fn`.
 *
 * The seam for a framework that resolves in one place and does the work in another. An adapter with
 * one hook around the run does not need it -- `AgentControl.run` already is that scope -- but an
 * adapter whose framework hands it two hooks per run, an instruction callable and a model wrapper,
 * has to make them agree. Resolving in each of them means a value published between the two, or a
 * rollout that lands differently on two reads, can send prompt A with model B while the telemetry
 * attributes the request to B alone. Resolving once and installing it here means both hooks read the
 * same value:
 *
 * ```ts
 * const resolution = await control.resolution(); // resolved once, at the run seam
 * await useResolution(resolution, async () => {
 *   // ... anywhere inside, including a hook the framework calls back into:
 *   const same = control.currentResolution(); // the one this run resolved
 * });
 * ```
 *
 * Entering also re-establishes the resolution's telemetry, exactly as `AgentControl.run` does, so
 * spans inside `fn` carry the label and version that produced them. Nesting is fine: an inner scope
 * shadows an outer one for that agent, and the outer one comes back when `fn` returns.
 *
 * The **unit of resolution** is a decision each adapter documents, because frameworks differ in what
 * they offer. Where there is a run seam -- something that brackets a whole agent run -- resolve once
 * per run, so every span of the run agrees on the version that produced it and a value published
 * mid-run takes effect on the next run. Where there is only a per-model-request hook, resolution is
 * per request, and a rollout can move between two requests of one run. Both are supportable; what is
 * not is implying the first while doing the second.
 */
export async function useResolution<T>(resolution: Resolution, fn: () => Promise<T> | T): Promise<T> {
  // Rebuilt rather than held: what the telemetry context *is* is the name, label, and version, and an
  // adapter that carried a `Resolution` through its framework's own per-run state no longer has the
  // SDK object that produced it.
  const resolved = new ResolvedVariable<AgentConfig | null>({
    name: resolution.variableName,
    value: resolution.config,
    // `Resolution.reason` is widened to `string` so a reason a newer SDK adds does not fail an
    // adapter's build; it only ever holds one the SDK gave us.
    reason: resolution.reason as VariableResolutionReason,
    ...(resolution.label === null ? {} : { label: resolution.label }),
    ...(resolution.version === null ? {} : { version: resolution.version }),
  })
  const resolutions = new Map(scope.getStore()).set(resolution.variableName, resolution)
  return scope.run(resolutions, async () => resolved.withContext(fn))
}

/**
 * The resolution installed for `variableName` by the innermost enclosing scope, if any.
 *
 * `null` means no scope is open for that agent here -- an adapter's hook reached outside a run, or a
 * run that never resolved -- which is not an error: it means the same thing an unresolved config
 * does, run the agent as written.
 */
export function currentResolution(variableName: string): Resolution | null {
  return scope.getStore()?.get(variableName) ?? null
}

/**
 * The variable for one agent, registered with the SDK on first use.
 *
 * The codec is what ties the three halves of the contract together: `jsonSchema` is what
 * `toConfig()` stores on a newly created variable, `parse` is the lenient reader, and the default is
 * the empty config -- the only code-side default there is, since the agent itself is what a
 * published value is layered onto and a second place to say that would only be somewhere for the two
 * to disagree.
 */
function agentVariable(variableName: string): Variable<AgentConfig> {
  const existing = variables.get(variableName)
  if (existing !== undefined) {
    return existing
  }
  const options = {
    default: {} as AgentConfig,
    description: 'Agent Control configuration: instructions, model, settings, and tool definition overrides.',
    codec: {
      jsonSchema: AGENT_CONFIG_JSON_SCHEMA,
      parse: parseAgentConfig,
    },
  }
  let variable: Variable<AgentConfig>
  try {
    variable = defineVar<AgentConfig>(variableName, options)
  } catch {
    // The name is registered, but not by us -- an application that defined this variable itself.
    // Theirs stays the registered one; ours reads the same name through the same provider.
    variable = new Variable<AgentConfig>(variableName, options)
  }
  variables.set(variableName, variable)
  return variable
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Clear this module's process-wide state. Intended for tests only. */
export function resetProcessState(): void {
  variables.clear()
  resetConfigHintGuard()
}
