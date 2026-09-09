/**
 * Reporting for managed values that this process could not act on.
 *
 * Two kinds of thing get reported here, and they differ in who is at fault. A *drop* is a value this
 * SDK could not make sense of -- a malformed setting, an entry that says nothing -- and is always a
 * warning, because the alternative is failing the whole config and reverting the agent to code over
 * one bad field. An *unmatched* entry is a perfectly valid value that reached nothing in this
 * deployment, and what happens to it is the caller's `onUnmatched` policy.
 */

/** What to do with a published entry that reaches nothing in this deployment. */
export type OnUnmatched = 'ignore' | 'warn' | 'error'

/**
 * Thrown by `onUnmatched: 'error'` for an entry that reached nothing.
 *
 * A distinct class rather than a bare `Error` so an adapter can let it through its own error
 * handling deliberately: the run is being failed on purpose, by configuration, and should not be
 * caught by a `catch` meant for a model or tool failure.
 */
export class UnmatchedConfigError extends Error {
  override name = 'UnmatchedConfigError'
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
 * These are the runtime decisions: what a *valid* published value did not reach in *this*
 * deployment, on *this* request. They are deliberately not the parser's compatibility warnings -- an
 * entry a newer UI wrote that this release cannot understand -- which are about the value rather than
 * the request, warn once per process from parsing, and never take an `onUnmatched` policy.
 */
export type UnappliedReason =
  | 'unknown-id'
  | 'dynamic-id'
  | 'oversized-text'
  | 'unknown-tool'
  | 'unknown-parameter'
  | 'no-patchable-schema'
  | 'rename-collision'

/**
 * One published entry that reached nothing, with the path that says which one.
 *
 * Returned by the apply helpers so an adapter can do more than repeat the message: count them,
 * attach them to a span, decide per section, or feed the tool ones back into its own routing. The
 * fields are a path, and only the ones that apply to `reason` are set -- `tool` and `parameter` on a
 * parameter patch, `instructionId` on an instruction entry -- so an adapter never has to parse
 * `message` to learn what an entry was about.
 *
 * The helpers report every entry they return under the caller's `onUnmatched` policy before returning
 * it, so an adapter that only wants the configured behavior can ignore these entirely and one that
 * wants both does not get the message twice.
 */
export interface UnappliedEntry {
  /** Why it was not applied; see `UnappliedReason`. */
  readonly reason: UnappliedReason
  /** What the policy reports: what was published, and what was not applied. */
  readonly message: string
  /** The instruction `id` the entry addressed, for the instruction reasons. */
  readonly instructionId?: string
  /** The toolset the entry named or the tool came from, when either has one. */
  readonly toolset?: string | null
  /** The code-side tool name the entry named, for the tool reasons. */
  readonly tool?: string
  /** The parameter the entry patched, for `'unknown-parameter'` and `'no-patchable-schema'`. */
  readonly parameter?: string
}

/**
 * Apply one `onUnmatched` policy to every entry that reached nothing, and hand them back.
 *
 * One call site per helper, so the policy governs *all* of a section's decisions rather than the
 * subset that happened to be routed through it: a rename dropped for colliding is as much a gap
 * between what Logfire shows and what the agent does as an override naming a tool that is not there,
 * and `'ignore'` has to silence both while `'error'` has to fail on both.
 *
 * Throws `UnmatchedConfigError` on the first entry when `policy` is `'error'`.
 */
export function reportUnappliedEntries(policy: OnUnmatched, entries: readonly UnappliedEntry[]): readonly UnappliedEntry[] {
  for (const entry of entries) {
    reportUnmatched(policy, entry.message)
  }
  return entries
}
