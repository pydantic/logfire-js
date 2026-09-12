/**
 * Reporting for managed values that this process could not act on.
 *
 * Two kinds of thing get reported here, and they differ in who is at fault. A *drop* is a value this
 * SDK could not make sense of -- a malformed setting, an entry that says nothing -- and is always a
 * warning, because the alternative is failing the whole config and reverting the agent to code over
 * one bad field. An *unmatched* entry is a perfectly valid value that reached nothing in this
 * deployment, and what happens to it is the caller's `onUnmatched` policy.
 */

/**
 * What to do with a published entry that reaches nothing in this deployment.
 *
 * The policy is applied in one place, by `AgentControl.report`, rather than inside each apply helper:
 * an adapter plans every section and then reports, so `'error'` fails on everything the request would
 * have got wrong rather than on whichever section happened to be planned first.
 */
export type OnUnmatched = 'ignore' | 'warn' | 'error'

/**
 * Thrown by `onUnmatched: 'error'` for everything one request could not apply.
 *
 * A distinct class rather than a bare `Error` so an adapter can let it through its own error handling
 * deliberately: the run is being failed on purpose, by configuration, and should not be caught by a
 * `catch` meant for a model or tool failure. It also lets an adapter translate it into its own
 * framework's error type without restating a single message:
 *
 * ```ts
 * try {
 *   control.report(...issues)
 * } catch (error) {
 *   if (error instanceof UnmatchedConfigError) {
 *     throw new MyFrameworkError(error.message)
 *   }
 *   throw error
 * }
 * ```
 *
 * Thrown once for a whole request, with every issue's message in `message` and the issues themselves
 * on `issues`, so an adapter that reports a kind it has never heard of still reports it faithfully.
 */
export class UnmatchedConfigError extends Error {
  override name = 'UnmatchedConfigError'

  /**
   * Every issue this request could not apply, in the order they were planned.
   *
   * Empty for the string channel -- `AgentControl.reportUnmatched` -- which carries a message and no
   * path.
   */
  readonly issues: readonly ApplyIssue[]

  constructor(message: string, issues: readonly ApplyIssue[] = []) {
    super(message)
    this.issues = issues
  }
}

/**
 * Messages already emitted in this process, keyed by the message itself.
 *
 * Deduplicating on the message rather than on the field costs nothing in clarity -- each message
 * names its subject and the offending value -- and still lets a *different* unrecognized value
 * surface later, which a per-field guard would swallow.
 */
const warned = new Set<string>()

/**
 * Surface a dropped or unapplied managed value once per process.
 *
 * A drop means Logfire shows one thing and the agent does another, which has to be visible. But the
 * config is resolved on every single run, so warning per drop would bury that signal under its own
 * repetition.
 */
export function warnOnce(message: string): void {
  if (warned.has(message)) {
    return
  }
  warned.add(message)
  console.warn(message)
}

/**
 * Apply an `onUnmatched` policy to one published entry that reached nothing.
 *
 * Called where the entry would have been applied -- `applySettings`, `applyInstructions`,
 * `applyToolDefinitions` -- and never from parsing. Parsing runs inside the SDK's variable
 * resolution, which turns a throw into a fallback to the code-defined agent, so an `'error'` raised
 * there would be swallowed and un-manage the whole config instead of stopping the run.
 *
 * The message is the same under every policy, so a warning someone chose to tolerate reads like the
 * error they would have gotten by not tolerating it.
 */
export function reportUnmatched(policy: OnUnmatched, message: string): void {
  if (policy === 'error') {
    throw new UnmatchedConfigError(message)
  }
  if (policy === 'warn') {
    warnOnce(message)
  }
}

/**
 * Render a value the way the reference implementation's Python `!r` does, for warning text.
 *
 * Warnings name the offending value, and the two SDKs' messages are compared against each other, so
 * strings are single-quoted rather than JSON's double-quoted and `null`/`undefined` read as Python's
 * `None`. Anything structural falls back to JSON, which both sides agree on.
 */
export function repr(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  }
  if (value === null || value === undefined) {
    return 'None'
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False'
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    // Asserted because `JSON.stringify` is typed as returning `string` while it genuinely returns
    // `undefined` for a function or a symbol -- which is exactly the kind of odd value a warning has
    // to be able to name.
    const json = JSON.stringify(value) as string | undefined
    return json ?? describeUnserializable(value)
  } catch {
    return describeUnserializable(value)
  }
}

/**
 * Name a value JSON could not render: a function, a symbol, something circular.
 *
 * Lint would rather this were not `String` of an `unknown`, and in general it is right, since a plain
 * object renders as `[object Object]`. Here that is the answer: the value has already failed to
 * serialize, and a warning that names it however it names itself beats one that drops it.
 */
function describeUnserializable(value: unknown): string {
  return String(value)
}

/** Clear the once-per-process warning memory. Intended for tests only. */
export function resetWarnings(): void {
  warned.clear()
}

/**
 * Why one published entry did not reach the request, as a stable string an adapter can branch on.
 *
 * Instructions:
 *
 * - `'unknown-id'` -- an `id` this request assembles no block under.
 * - `'dynamic-id'` -- an `id` only a block the framework recomputes per request carries, which cannot
 *   be replaced or dropped without pinning or removing that computation.
 * - `'oversized-text'` -- text past the contract's per-request budget, which is refused rather than
 *   truncated: half a prompt is not a smaller version of the prompt.
 *
 * Tools:
 *
 * - `'unknown-tool'` -- a `name` (narrowed by `toolset` when the entry sets one) no advertised tool
 *   has.
 * - `'unknown-parameter'` -- a `parameters` key the tool's schema has no top-level property for.
 * - `'no-patchable-schema'` -- the tool, or that one property, has no object schema to patch a
 *   description into at all.
 * - `'rename-collision'` -- a `new_name` another advertised tool, or a name the adapter reserved,
 *   already answers to. The rename is dropped and the tool keeps its code-side name; the same entry's
 *   other patches still apply.
 *
 * Settings:
 *
 * - `'unknown-setting'` -- a `settings` key this release has no field for, which a newer Logfire UI
 *   can write.
 * - `'unsupported-setting'` -- a canonical key this adapter declared it cannot lower; see
 *   `AgentSupport.settings`.
 * - `'unrepresentable-timeout'` -- a `timeout` that is not a request budget: negative, not finite, or
 *   past `MAX_TIMEOUT_SECONDS`.
 *
 * Any section:
 *
 * - `'unknown-section'` -- a top-level key this release has no section for. Every section is optional
 *   and unknown keys cost nothing, which is what lets a future section be written against an older
 *   SDK -- but the drop has to be audible, or the first person to publish one gets a silently
 *   degraded agent.
 * - `'unsupported-section'` -- a section this release understands and this adapter cannot apply; see
 *   `AgentSupport.sections`.
 * - `'duplicate-entry'` -- the same instruction `id`, or the same `(toolset, name)`, written twice.
 *   The first is applied and the rest are not.
 * - `'dropped-by-provider'` -- a setting the adapter did forward and the provider or its SDK dropped;
 *   see `droppedByProvider`.
 *
 * These are the runtime decisions: what a *valid* published value did not reach in *this*
 * deployment, on *this* request. They are deliberately not the parser's compatibility warnings -- an
 * entry a newer UI wrote that this release cannot understand -- which are about the value rather than
 * the request, warn once per process from parsing, and never take an `onUnmatched` policy.
 */
export type ApplyIssueReason =
  | 'unknown-id'
  | 'dynamic-id'
  | 'oversized-text'
  | 'unknown-tool'
  | 'unknown-parameter'
  | 'no-patchable-schema'
  | 'rename-collision'
  | 'unknown-setting'
  | 'unsupported-setting'
  | 'unrepresentable-timeout'
  | 'unknown-section'
  | 'unsupported-section'
  | 'duplicate-entry'
  | 'dropped-by-provider'

/**
 * One published entry that reached nothing, with the path that says which one.
 *
 * Returned by the apply helpers, which report nothing themselves: an adapter collects the issues of
 * every section it planned and hands them to `AgentControl.report` once. That is what makes the
 * return value load-bearing rather than a duplicate of a warning already emitted, and what lets
 * `'error'` fail on everything a request got wrong instead of on the first section planned.
 *
 * The fields are a path, and only the ones that apply to `reason` are set -- `tool` and `parameter`
 * on a parameter patch, `instructionId` on an instruction entry, `setting` on a settings key -- so an
 * adapter never has to parse `message` to learn what an issue was about.
 */
export interface ApplyIssue {
  /**
   * Which section of the config the issue is about.
   *
   * One of the four `Section` names, except for `'unknown-section'`, where it is the unrecognized
   * top-level key itself: a key this release has no section for has no section name to give, and
   * naming the key is what makes the report actionable. Typed as a plain string for that reason, in
   * both cores.
   */
  readonly section: string
  /** Why it was not applied; see `ApplyIssueReason`. */
  readonly reason: ApplyIssueReason
  /** What the policy reports: what was published, and what was not applied. */
  readonly message: string
  /** The instruction `id` the entry addressed, for the instruction reasons. */
  readonly instructionId?: string
  /** The instruction destination the entry named, when it named one. */
  readonly destination?: string
  /** The toolset the entry named or the tool came from, when either has one. */
  readonly toolset?: string | null
  /** The code-side tool name the entry named, for the tool reasons. */
  readonly tool?: string
  /** The parameter the entry patched, for `'unknown-parameter'` and `'no-patchable-schema'`. */
  readonly parameter?: string
  /** The canonical settings key the issue is about, for the settings reasons. */
  readonly setting?: string
}

/**
 * One setting the adapter forwarded and the provider, or its own SDK, did not apply.
 *
 * The one issue the core cannot find for itself: it is discovered *after* the request, by an adapter
 * reading whatever its framework reports -- the Vercel AI SDK's `result.warnings`, a provider's own
 * "unsupported parameter" note. Those shapes differ per SDK and the core knows none of them, so it
 * takes the two things every one of them carries: which canonical setting, and what the SDK said
 * about it.
 *
 * ```ts
 * control.report(...result.warnings.map((w) => droppedByProvider('top_k', w.details)))
 * ```
 */
export function droppedByProvider(setting: string, detail: string): ApplyIssue {
  return {
    section: 'settings',
    reason: 'dropped-by-provider',
    setting,
    message:
      `Managed agent config sets ${repr(setting)}, which the provider did not apply -- ${detail}; ` +
      'that key had no effect on the request.',
  }
}

/**
 * Apply one `onUnmatched` policy to every issue a request's planning produced.
 *
 * One call for a whole request, which is the point: the apply helpers plan and report nothing, so
 * `'error'` throws after every section has been planned, naming all of it, rather than on the first
 * entry of the first section -- which used to mean the strictest policy reported the least.
 *
 * Throws `UnmatchedConfigError`, naming every issue, when `policy` is `'error'`.
 */
export function reportIssues(policy: OnUnmatched, issues: readonly ApplyIssue[]): void {
  if (issues.length === 0) {
    return
  }
  if (policy === 'error') {
    throw new UnmatchedConfigError(issues.map((issue) => issue.message).join('\n'), issues)
  }
  if (policy === 'warn') {
    for (const issue of issues) {
      warnOnce(issue.message)
    }
  }
}
