/**
 * What an adapter can do with a published config, declared as data rather than inferred.
 *
 * Two facts about an agent are known only to its adapter and are needed everywhere else: which
 * sections and settings it can actually apply, and how faithfully it can tell an explicit per-run
 * setting from a default. Both used to be prose -- a README footnote, an `if` in a hook -- and the
 * Logfire editor inferred the first by reading the variable's `example`, which cannot tell "this
 * adapter cannot apply `tool_definitions`" from "this agent has no tools".
 *
 * `AgentSupport` is that knowledge as one value: built by the adapter, published with the baseline,
 * and read by the editor. It describes the **adapter**, and only the adapter. What a particular model
 * does with a setting the adapter forwarded is deliberately not here -- it goes out of date the week
 * a provider ships, it belongs to whatever curates model metadata, and every framework Agent Control
 * drives already has its own reasoning for settings a model will not take.
 */

/** The four sections of an `AgentConfig`, which are also the four things an adapter may not be able to apply. */
export type Section = 'instructions' | 'model' | 'settings' | 'tool_definitions'

/**
 * One named sink an adapter can put instruction text into.
 *
 * A framework with one prompt has one destination; a framework with several -- a CLI preset and a
 * system prompt, a session prefix and a per-turn prefix -- has one per sink, and a published addition
 * says which of them it means rather than an index into a list only the adapter can see.
 *
 * Declared here and consumed where instructions are applied, so the editor learns the sinks from the
 * same value that tells it which sections exist.
 */
export interface Destination {
  /** The name a published addition routes to, and the name the editor offers. */
  readonly id: string
  /**
   * Whether an addition that names no destination lands here.
   *
   * At most one destination should say `true`. An adapter with a single sink can leave it out and let
   * the first destination be the fallback, which is what one sink means anyway.
   */
  readonly default?: boolean
  /**
   * Whether published text may be added to this sink at all. Defaults to `true`.
   *
   * `false` is for a sink an adapter can rewrite but not grow -- a fixed-shape preset, a field with
   * one slot -- where the editor should offer editing and not "add a block".
   */
  readonly acceptsAdditions?: boolean
}

/**
 * What this adapter can apply, declared once and carried with the baseline.
 *
 * An adapter builds one of these and passes it to the apply helpers, which use it to say -- rather
 * than silently do nothing about -- a published section or setting this framework cannot lower. The
 * Logfire editor reads the same value to grey out what it would be pointless to publish.
 *
 * Nothing here is about a model. A published `temperature` a reasoning model refuses, or a
 * `presence_penalty` a provider rejects outright, reaches that provider and fails the request unless
 * the adapter's own reasoning drops it first: that is the adapter's table to get right, and Agent
 * Control carries none of it.
 */
export interface AgentSupport {
  /**
   * The sections this adapter can apply at all.
   *
   * A published section outside this list is reported once, rather than silently doing nothing, which
   * is the difference between an editor that greys a section out and one that offers an edit that
   * will never take effect.
   */
  readonly sections: readonly Section[]
  /**
   * The named instruction sinks; see `Destination`.
   *
   * Also what the editor offers "add a block" for. Absent means the adapter has one unnamed sink,
   * which is every framework with a single prompt.
   */
  readonly destinations?: readonly Destination[]
  /**
   * The canonical setting keys this adapter can lower into its framework.
   *
   * An empty list declares that it can lower none of them, so an adapter that applies settings has to
   * say which. Passing no support at all to `applySettings` is the other way to say "all of them",
   * for an adapter that has not been taught to declare yet.
   */
  readonly settings?: readonly string[]
  /**
   * How faithfully this adapter can tell an explicit per-run setting from a default.
   *
   * - `'exact'`: it sees the keys the caller set for this run, so the contract's precedence -- code,
   *   then published, then the run -- holds exactly.
   * - `'inferred'`: it diffs the framework's effective settings against the defaults, so a run that
   *   re-sets a value that happens to be the default loses to the published one.
   * - `'code-wins'`: there is no run layer to read, or the framework writes its own values last, so a
   *   code-side value beats a published one and cannot be made not to from outside.
   *
   * Nothing verifies this; it is a declaration, and a wrong one is a wrong hint in the editor about
   * when a published value will win. Defaults to `'exact'`.
   */
  readonly precedence?: 'exact' | 'inferred' | 'code-wins'
  /**
   * What one resolved config covers, which is what the editor tells a user about when a change takes
   * effect.
   *
   * `'run'` is a whole agent run, `'request'` is one model request inside it, and `'session'` is a
   * conversation the framework snapshots once -- where a published change reaches the next session
   * rather than the next request. Defaults to `'run'`.
   */
  readonly resolutionUnit?: 'run' | 'request' | 'session'
}
