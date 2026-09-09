/**
 * The variable behind one agent's managed config: reading the published value, publishing the
 * baseline.
 *
 * Everything remote lives here. The helpers in `./instructions.ts`, `./tools.ts`, `./settings.ts`,
 * and `./baseline.ts` are pure, so an adapter's tests never need a provider, and this class is the
 * only thing that has to know a Logfire project exists.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { defineVar, getVariableProvider, NoOpVariableProvider, ResolvedVariable, Variable } from 'logfire/vars'
import type { VariableConfig, VariableProvider, VariableResolutionReason } from 'logfire/vars'

import { parseAgentConfig } from './config'
import type { AgentConfig } from './config'
import { agentVariableName } from './names'
import { AGENT_CONFIG_JSON_SCHEMA } from './schema'
import { reportUnmatched as report, warnOnce } from './warnings'
import type { OnUnmatched } from './warnings'

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

/**
 * Where a published baseline came from, which an adapter has to say because it changes what it means.
 *
 * - `'code'` is the agent *as written*: read off the agent object, its declared prompts, its declared
 *   settings, its tool definitions. It describes every request the agent will make.
 * - `'observed'` is one request, snapshotted because the framework offers nothing to read the agent
 *   from until it runs. It describes the request it came from and nothing else, so a prompt or a tool
 *   list assembled from the run's own input is a sample rather than a description -- and text that
 *   came from a request is one tenant's, one user's, one retrieved document's, published into a
 *   variable every member of the Logfire project can read.
 *
 * The distinction is not cosmetic: an adapter that can only observe should mark blocks it did not find
 * in code as dynamic rather than publishing their rendered text, and the editor has to be able to tell
 * a description of the code from a description of one request that happened first.
 */
export type BaselineSource = 'code' | 'observed'

/** Options for `AgentControl.publishBaseline`. */
export interface PublishBaselineOptions {
  /**
   * Whether the baseline describes the agent as written or one request that happened to come first.
   *
   * An adapter that reads its framework's agent object leaves this at `'code'`. One whose framework
   * assembles its prompt or tool list from callables, so that the earliest anything can be read is a
   * request, passes `'observed'` and says so, rather than letting a snapshot of one request stand in
   * for a description of the code. A new process publishes again, so a changed deployment updates
   * either kind.
   */
  source?: BaselineSource
}

/** What a newly created variable says about itself, which depends on what its example actually is. */
const BASELINE_DESCRIPTIONS: Record<BaselineSource, string> = {
  code:
    'Agent Control config for this agent. The example is the agent as written, published by the SDK; ' +
    'set a value here to change what the agent sends, and remove it to go back to the code.',
  observed:
    'Agent Control config for this agent. The example was snapshotted from one request, because this ' +
    'framework offers nothing to read the agent from until it runs, so it describes that request rather ' +
    'than every one. Set a value here to change what the agent sends, and remove it to go back to the code.',
}

/**
 * Destinations a baseline publish has been attempted for in this process.
 *
 * Marked *before* the work starts, so concurrent first requests cannot schedule duplicate writes and
 * a failure is not retried by every later run.
 */
const baselinePublishAttempted = new Set<string>()

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
  /** What to do with a published entry that reaches nothing; passed on to the `apply*` helpers. */
  onUnmatched?: OnUnmatched
  /**
   * Whether to publish the code-side baseline to the variable's `example`.
   *
   * On by default because `example` is documentation for the Logfire editor and is never resolved or
   * applied to a run, so a failed or stale publish cannot change agent behavior. Turn it off when the
   * variables token is intentionally read-only, or when code must not write variable metadata.
   */
  publishBaseline?: boolean
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
 * control.publishBaseline(buildBaseline({ instructions: codeBlocks, model, tools }));
 *
 * return await control.run(async ({ config }) => {
 *   const blocks = config === null ? codeBlocks : applyInstructions(codeBlocks, config).blocks;
 *   return runTheAgent(blocks);
 * });
 * ```
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
  /** The policy this control passes to the `apply*` helpers by default. */
  readonly onUnmatched: OnUnmatched

  readonly #publishBaseline: boolean
  readonly #variable: Variable<AgentConfig>

  constructor(name: string, options: AgentControlOptions = {}) {
    // Before anything is assigned, because a name with nothing to key on is not an agent this class
    // can back: `agentVariableName` throws, naming the rule and what it needs.
    this.variableName = agentVariableName(name)
    this.name = name.trim()
    this.label = options.label
    this.onUnmatched = options.onUnmatched ?? 'warn'
    this.#publishBaseline = options.publishBaseline ?? true
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
   * Report something this adapter could not apply, under this control's `onUnmatched` policy.
   *
   * The `apply*` helpers report the entries *they* could not place, but they only see the section
   * they were given. A whole section an adapter cannot act on at all -- a published `model` on a
   * framework with no way to switch models, a `tool_definitions` section on one whose tools are
   * fixed -- is the same gap between what Logfire shows and what the agent does, and has to reach the
   * same policy rather than a `console.log` in the adapter.
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
    const resolved: ResolvedVariable<AgentConfig> = await this.#variable.get(this.label === undefined ? {} : { label: this.label })
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
   * Publish a baseline as the variable's `example`, creating the variable if needed.
   *
   * Returns immediately. The write is a remote round trip and the baseline is documentation for the
   * Logfire editor that no run ever reads, so making a model request wait on it would trade something
   * that matters for something that does not. Failures are warned about and never thrown: this is
   * called from the middle of an agent run, and a variable's metadata not being up to date must not be
   * what takes that run down.
   *
   * At most once per process per variable, and the guard is marked *before* the work starts, so
   * concurrent first requests cannot schedule duplicate writes and a failure is not retried by every
   * later run. That is also what makes the caller's job easy: call it on every request and let this
   * decide.
   *
   * If the variable does not exist, it is created with `AGENT_CONFIG_JSON_SCHEMA` as its stored
   * schema, which is what makes the Logfire UI able to edit it -- the backend validates every value
   * written against that schema, so whichever side creates the variable first fixes the contract.
   *
   * ## A lost update is still possible here, and cannot be closed from this side
   *
   * Updating an existing variable is read-modify-write, because the API offers nothing narrower: the
   * update endpoint takes the whole definition and no revision or `If-Match`. Everything a client can
   * do to narrow that window is done, and it is worth being exact about what is and is not left:
   *
   * - The variable is only ever *created* when the read says it is missing, so the common case for a
   *   new agent involves no overwrite at all.
   * - An existing variable is **re-read immediately before the write**, and the object written is
   *   that fresh read with `example` replaced -- never one read earlier, and never one a caller passed
   *   in. Whatever the UI saved up to that read is preserved: values, labels, rollout, description.
   * - The write is skipped entirely when the fresh read already carries this `example`, which is the
   *   steady state for a deployed agent, so the overwhelmingly common outcome is no write.
   * - It runs at most once per process per variable, off the request path.
   *
   * What remains is one HTTP round trip: a value or label saved in the Logfire UI *between* the fresh
   * read returning and the write landing is overwritten by the older state that read returned, and the
   * UI reports success for the publish it just lost. Closing it needs an example-only `PATCH`, or a
   * conditional write on a revision or ETag, on the platform API:
   * https://github.com/pydantic/pydantic-ai-harness/issues/565. Until then, a deployment that cannot
   * tolerate that window sets `publishBaseline: false` and creates the variable in the UI, and a
   * successful baseline write is **not** evidence that managed values survived it.
   *
   * @param baseline What to publish, from `buildBaseline`.
   * @param options `source` says whether `baseline` describes the agent as written or one request
   * that happened to come first; see `BaselineSource`.
   */
  publishBaseline(baseline: AgentConfig, options: PublishBaselineOptions = {}): void {
    if (!this.#publishBaseline) {
      return
    }
    if (baselinePublishAttempted.has(this.variableName)) {
      return
    }
    baselinePublishAttempted.add(this.variableName)
    const source = options.source ?? 'code'
    let example: string
    try {
      example = JSON.stringify(baseline, null, 2)
    } catch (error) {
      this.#publishFailed(error)
      return
    }
    this.#publish(example, source).catch((error: unknown) => {
      this.#publishFailed(error)
    })
  }

  #publishFailed(error: unknown): void {
    warnOnce(`Failed to publish the code baseline for Logfire managed variable '${this.variableName}': ` + describe(error))
  }

  async #publish(example: string, source: BaselineSource): Promise<void> {
    const provider: VariableProvider = getVariableProvider()
    // A provider with no write path is one there is nothing to publish into: the no-op provider
    // stands in for "variables are switched off", and a custom read-only one is saying the same.
    if (provider instanceof NoOpVariableProvider) {
      return
    }
    const existing = await provider.getVariableConfig?.(this.variableName)
    // `== null` rather than a strict pair: the provider interface types this as `VariableConfig |
    // undefined`, and a custom provider that answers `null` should still read as "no such variable".
    if (existing == null) {
      const config: VariableConfig = {
        ...this.#variable.toConfig(),
        example,
        description: BASELINE_DESCRIPTIONS[source],
      }
      await provider.createVariable?.(config)
      return
    }
    // Deliberately its own read rather than reusing the one that decided the variable exists: the
    // value written back is the whole variable definition, so every moment between reading it and
    // writing it is a moment in which someone else's edit is inside the object about to be
    // overwritten. Taking the read here makes that window one round trip instead of two, and makes
    // "never write from a config read earlier" a property of the code rather than a rule to remember.
    const fresh = await provider.getVariableConfig?.(this.variableName)
    // Vanished between the two reads, or already carries this baseline. Either way there is nothing
    // to write, and re-creating a variable someone just deleted is not this call's decision to make.
    if (fresh == null || fresh.example === example) {
      return
    }
    await provider.updateVariable?.(this.variableName, { ...fresh, example })
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
  baselinePublishAttempted.clear()
}
