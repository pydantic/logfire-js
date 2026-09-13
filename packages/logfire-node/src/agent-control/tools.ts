/**
 * Applying the `tool_definitions` section to the tools a framework advertises to the model.
 *
 * Overrides change only what the model is shown. Parameter names, types, requiredness, validation,
 * and the implementation behind a tool stay code-defined, which is why the result carries routing
 * tables: a renamed tool has to be callable under its new name and still run the old one.
 */

import type { AgentConfig, ParameterOverride, ToolDefinitionOverride } from './config'
import type { JsonSchema } from './schema'
import { repr } from './warnings'
import type { ApplyIssue, ApplyIssueReason } from './warnings'

/**
 * One tool's LLM-facing definition as a framework advertises it, and as this package hands it back.
 *
 * Unlike `ToolDefinitionOverride`, which is the wire shape of a *patch*, this is the tool itself, and
 * it never reaches the wire -- so its fields are named the way a TypeScript adapter would name them.
 */
export interface ToolDef {
  /** The tool's name as the model sees it. On input, its code-side name. */
  name: string
  /** The tool's description as the model sees it. */
  description?: string
  /** The tool's parameters as a JSON Schema object. */
  parametersJsonSchema: JsonSchema
  /**
   * The toolset this tool came from, or `null`/absent when the framework has no such grouping.
   *
   * It is what an override narrows its match by, so an adapter should report it as one stable string
   * per toolset -- an id where the framework has one, its label otherwise -- and use the same value
   * when building a baseline, so the value the Logfire editor shows is exactly the value an override
   * can be written against.
   */
  toolset?: string | null
}

/**
 * Where two advertised tool names actually collide, which is a property of the framework.
 *
 * A rename is only safe if the core can tell whether the new name is already taken, and "taken" is
 * not the same question everywhere:
 *
 * - `'global'` (the default): every tool is advertised into one flat namespace, so any two tools with
 *   the same advertised name collide. Almost every framework -- the AI SDK, Mastra, OpenAI Agents,
 *   LangChain -- works this way.
 * - `'toolset'`: the runtime name a tool is advertised under already carries its toolset, as the
 *   Claude Agent SDK's `mcp__<server>__<tool>` does, so two servers may each advertise a `search`,
 *   and renaming one of them to `lookup` does not collide with another server's `lookup`.
 *
 * Getting this wrong is not cosmetic in either direction: too wide drops a legal rename, too narrow
 * advertises two tools under one name and makes a call unroutable.
 */
export type CollisionScope = 'global' | 'toolset'

/**
 * The identity a tool is matched and routed by: its toolset and its name, as one string.
 *
 * A string rather than a tuple because it is a `Map` key, and two tuples with the same contents are
 * two different keys. Build one with `toolKey` and never by hand: the encoding is this module's, and
 * the only thing it guarantees is that `toolKey` round-trips through a `Map` lookup.
 */
export type ToolKey = string

/**
 * The key `(toolset, name)` is looked up under, with `null` and absent meaning the same thing.
 *
 * An adapter reading `forward` or `reverse` calls this with the toolset it knows the tool by and the
 * name it is asking about; an adapter whose framework has no toolsets passes `null`.
 */
export function toolKey(toolset: string | null | undefined, name: string): ToolKey {
  return JSON.stringify([toolset ?? null, name])
}

function splitToolKey(key: ToolKey): [string | null, string] {
  return JSON.parse(key) as [string | null, string]
}

function describeToolKey(key: ToolKey): string {
  const [toolset, name] = splitToolKey(key)
  return toolset === null ? `tool ${repr(name)}` : `tool ${repr(name)} from toolset ${repr(toolset)}`
}

/** What `applyToolDefinitions` returns: the tools to advertise, and where a call comes back to. */
export interface AppliedTools {
  /** The tools to advertise, in the order they were given, with managed definitions applied. */
  tools: ToolDef[]
  /**
   * Advertised name to code-side name, for every tool.
   *
   * Total rather than rename-only so a dispatcher can look up any name the model calls without
   * special-casing the tools that were not renamed. Frameworks differ on whether the implementation
   * should see its old name or the new one, so the mapping is handed over rather than applied here.
   *
   * Flat, and therefore exact only under `collisionScope: 'global'`, where an advertised name
   * identifies a tool by itself. An adapter that passes `'toolset'` has said that two toolsets may
   * advertise the same name, so it routes through `reverse` instead; this mapping keeps the first of
   * such a pair.
   *
   * A null-prototype object, so a tool the model calls `constructor` or `toString` is a name this
   * table does not have rather than an inherited function an adapter would go on to invoke.
   */
  routes: Record<string, string>
  /**
   * `toolKey(toolset, code-side name)` to the name that tool is advertised under.
   *
   * The direction an adapter needs on the way *out*: rewriting a `toolChoice`, an active-tools list,
   * or a replayed history entry that names a tool by the name the code gave it. Keyed on the pair
   * rather than the bare name so a framework with toolsets rewrites exactly the one it means.
   */
  forward: ReadonlyMap<ToolKey, string>
  /**
   * `toolKey(toolset, advertised name)` to the tool's code-side name.
   *
   * The direction an adapter needs on the way *in*: a call arrives under an advertised name, and
   * under `collisionScope: 'toolset'` the adapter also knows which toolset it came from, which is
   * what keeps two servers' identically named tools distinguishable.
   */
  reverse: ReadonlyMap<ToolKey, string>
  /**
   * Every published tool entry, or part of one, this request did not apply; see `ApplyIssue`.
   *
   * Reported by nothing here; hand them to `AgentControl.report` with the rest.
   */
  issues: readonly ApplyIssue[]
}

/** Options for `applyToolDefinitions`. */
export interface ApplyToolDefinitionsOptions {
  /**
   * Advertised names this adapter needs kept free.
   *
   * An OpenAI Agents handoff, a provider-defined tool the framework adds after this call, anything
   * outside the editable list. A rename onto one of them is refused like any other collision. Read as
   * taken in every namespace, which is exact for a framework with one and deliberately conservative
   * for a framework with several.
   */
  reserved?: Iterable<string>
  /** Where two advertised names collide; see `CollisionScope`. */
  collisionScope?: CollisionScope
}

/**
 * Index overrides by the `(toolset, name)` each one patches, keeping the first of any duplicates.
 *
 * An entry without a `toolset` is keyed under `null`, so the same `name` can carry one unqualified
 * entry and one per toolset side by side; only two entries with the same pair collide.
 *
 * The duplicates come back rather than being warned from here: it is an apply-time decision about a
 * value, so it belongs under the caller's `onUnmatched` policy like every other one -- warning
 * directly, as this used to, meant `'ignore'` still warned and `'error'` did not throw.
 */
function overridesByKey(config: AgentConfig): {
  overrides: Map<ToolKey, ToolDefinitionOverride>
  duplicates: ApplyIssue[]
} {
  const overrides = new Map<ToolKey, ToolDefinitionOverride>()
  const duplicates: ApplyIssue[] = []
  for (const override of config.tool_definitions ?? []) {
    const key = toolKey(override.toolset, override.name)
    if (overrides.has(key)) {
      const [toolset, name] = splitToolKey(key)
      duplicates.push({
        section: 'tool_definitions',
        reason: 'duplicate-entry',
        toolset,
        tool: name,
        message: `Managed agent config names ${describeToolKey(key)} more than once; keeping the first entry and ignoring the rest.`,
      })
      continue
    }
    overrides.set(key, override)
  }
  return { overrides, duplicates }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parameterEntry(
  reason: Extract<ApplyIssueReason, 'unknown-parameter' | 'no-patchable-schema'>,
  tool: ToolDef,
  parameter: string,
  because: string
): ApplyIssue {
  return {
    section: 'tool_definitions',
    reason,
    toolset: tool.toolset ?? null,
    tool: tool.name,
    parameter,
    message:
      `Managed agent config patches parameter ${repr(parameter)} of ` +
      `${describeToolKey(toolKey(tool.toolset, tool.name))}, which ${because}; that patch applies to nothing.`,
  }
}

/** What `patchParameters` found: the schema to send, and the patches that reached nothing. */
interface PatchedParameters {
  schema: JsonSchema
  /** Names the schema has no top-level property for. */
  unknown: string[]
  /** Names whose property schema is not an object to patch a description into. */
  unpatchable: string[]
  /** Whether the tool has no top-level parameters at all, which makes every patch a miss. */
  noProperties: boolean
}

/**
 * Patch top-level parameter descriptions while preserving all other schema structure.
 *
 * Own-property lookups throughout: both sides of this come from JSON, so a parameter called
 * `constructor` must be a name the schema does not have rather than an inherited function.
 */
function patchParameters(schema: JsonSchema, parameters: Record<string, ParameterOverride>): PatchedParameters {
  const properties = schema['properties']
  const unknown: string[] = []
  const unpatchable: string[] = []
  if (!isRecord(properties)) {
    return { schema, unknown, unpatchable, noProperties: true }
  }
  // Null-prototype, for the same reason `routes` is: both sides of this come from JSON, so a
  // parameter genuinely called `__proto__` is an own key on the way in, and `newProperties[name] =`
  // on a plain object would set the prototype instead of that key -- dropping a code-defined
  // parameter out of the schema the model is sent.
  const newProperties = Object.create(null) as Record<string, unknown>
  let changed = false
  for (const [name, propertySchema] of Object.entries(properties)) {
    const description = Object.hasOwn(parameters, name) ? parameters[name]?.description : undefined
    if (description !== undefined && isRecord(propertySchema)) {
      newProperties[name] = { ...propertySchema, description }
      changed = true
    } else {
      newProperties[name] = propertySchema
    }
  }
  for (const [name, override] of Object.entries(parameters)) {
    if (!Object.hasOwn(properties, name)) {
      unknown.push(name)
    } else if (override.description !== undefined && !isRecord(properties[name])) {
      unpatchable.push(name)
    }
  }
  return {
    schema: changed ? { ...schema, properties: newProperties } : schema,
    unknown,
    unpatchable,
    noProperties: false,
  }
}

/**
 * Patch top-level parameter descriptions, for an adapter holding a schema of its own.
 *
 * Returns the original object when nothing changed, so an adapter that compares by identity can tell
 * a patched schema from an untouched one. Reporting is the caller's here: `applyToolDefinitions` is
 * what turns a patch that reached nothing into an `ApplyIssue` under a policy.
 */
export function withParameterDescriptions(schema: JsonSchema, parameters: Record<string, ParameterOverride>): JsonSchema {
  return patchParameters(schema, parameters).schema
}

/** Apply the LLM-facing parts of one override, returning the original definition for a no-op. */
function applyOverride(tool: ToolDef, override: ToolDefinitionOverride): { tool: ToolDef; issues: ApplyIssue[] } {
  const patched: ToolDef = { ...tool }
  const issues: ApplyIssue[] = []
  let changed = false
  if (override.new_name !== undefined && override.new_name !== tool.name) {
    patched.name = override.new_name
    changed = true
  }
  if (override.description !== undefined && override.description !== tool.description) {
    patched.description = override.description
    changed = true
  }
  if (override.parameters !== undefined) {
    const result = patchParameters(tool.parametersJsonSchema, override.parameters)
    if (result.schema !== tool.parametersJsonSchema) {
      patched.parametersJsonSchema = result.schema
      changed = true
    }
    // `'no-patchable-schema'` is "no object schema to patch a description *into*", so an entry
    // carrying no description asks for nothing and is not a gap between Logfire and the agent worth
    // reporting -- let alone worth failing the run under `onUnmatched: 'error'`. Gated the way
    // `patchParameters` already gates its per-property `unpatchable` case. `unknown` is deliberately
    // not gated: naming a parameter this deployment does not have is drift whether or not the entry
    // goes on to patch it.
    const missing = result.noProperties
      ? Object.entries(override.parameters)
          .filter(([, entry]) => entry.description !== undefined)
          .map(([name]) => name)
      : result.unknown
    const because = result.noProperties ? 'has no top-level parameters' : 'has no parameter of that name'
    const reason = result.noProperties ? 'no-patchable-schema' : 'unknown-parameter'
    for (const name of missing) {
      issues.push(parameterEntry(reason, tool, name, because))
    }
    for (const name of result.unpatchable) {
      issues.push(parameterEntry('no-patchable-schema', tool, name, 'describes that parameter with no schema object'))
    }
  }
  return { tool: changed ? patched : tool, issues }
}

/** The set of advertised names this tool competes in; see `CollisionScope`. */
function namespaceOf(tool: ToolDef, scope: CollisionScope): string | null {
  return scope === 'toolset' ? (tool.toolset ?? null) : null
}

/**
 * How many tools answer to each name in one namespace, created empty the first time it is asked for.
 *
 * Counted rather than a `Set` because a name can genuinely be held twice: under the default global
 * scope, `crm/search` and `docs/search` both advertise `search`. A rename has to put its code-side
 * name back down before checking -- otherwise a tool cannot rename into a name an earlier rename
 * freed -- and a set cannot tell "the only holder let go" from "one of two holders let go", which
 * would let a later rename take a name another tool still answers to.
 */
function namesTakenIn(taken: Map<string | null, Map<string, number>>, namespace: string | null): Map<string, number> {
  const existing = taken.get(namespace)
  if (existing !== undefined) {
    return existing
  }
  const names = new Map<string, number>()
  taken.set(namespace, names)
  return names
}

/** Record one more tool answering to `name`. */
function claim(names: Map<string, number>, name: string): void {
  names.set(name, (names.get(name) ?? 0) + 1)
}

/** Record one fewer tool answering to `name`, dropping the key when the last holder lets go. */
function release(names: Map<string, number>, name: string): void {
  const count = (names.get(name) ?? 0) - 1
  if (count > 0) {
    names.set(name, count)
  } else {
    names.delete(name)
  }
}

/**
 * Apply a managed config's `tool_definitions` section to the tools a request advertises.
 *
 * Pure: it reads `tools` and returns new definitions plus the routing tables for them.
 *
 * - A tool is matched by `name`, narrowed to one toolset's tool of that name when the override sets
 *   `toolset`. An override narrowed to a toolset beats one that only names the tool, so a config can
 *   say "every `search`" and "the CRM's `search`" at once and the specific entry wins where both
 *   apply. The unqualified entry is then outranked, not unmatched -- it still reached the tool it
 *   named -- so only an entry that matched no tool at all is reported.
 * - A rename onto a name that is already taken is **dropped** while that override's other patches
 *   still apply, so every tool keeps a name the model can call. What counts as taken is
 *   `collisionScope` plus `reserved`, and renames resolve in input order, so the tool that was there
 *   first keeps the name.
 * - Parameter descriptions are patched in place and every other piece of schema structure is
 *   preserved. A patch on a parameter the tool does not have, or on one whose schema is not an object
 *   to patch a description into, applies nothing -- a parameter is part of the tool's code-defined
 *   shape, and the baseline is what says which ones exist -- and is reported rather than dropped in
 *   silence.
 * - An override that matches nothing is reported per call rather than once, because tool availability
 *   is dynamic: a framework can advertise different tools from one step to the next, and a report
 *   from one listing is a report about that listing.
 *
 * - Two overrides naming one `(toolset, name)` keep the first and report the rest
 *   (`'duplicate-entry'`).
 *
 * Every one of those decisions comes back as an `ApplyIssue` on `issues`, and is reported by nothing
 * here: hand them to `AgentControl.report` along with the other sections'.
 */
export function applyToolDefinitions(
  tools: readonly ToolDef[],
  config: AgentConfig,
  options: ApplyToolDefinitionsOptions = {}
): AppliedTools {
  const collisionScope = options.collisionScope ?? 'global'
  const reserved = new Set(options.reserved ?? [])
  const { overrides, duplicates } = overridesByKey(config)

  // A namespace is the set of advertised names that compete: one for the whole request, or one per
  // toolset. Every code-side name starts out taken, so a rename onto a tool later in the list is a
  // collision rather than a name that is free until that tool is reached.
  const taken = new Map<string | null, Map<string, number>>()
  for (const tool of tools) {
    claim(namesTakenIn(taken, namespaceOf(tool, collisionScope)), tool.name)
  }

  const issues: ApplyIssue[] = [...duplicates]
  const matched = new Set<ToolKey>()
  const applied: ToolDef[] = []
  // Null-prototype, so `'constructor' in routes` is a question about this request's tools rather than
  // about `Object.prototype`, and a tool named `__proto__` becomes an entry rather than a new
  // prototype.
  const routes = Object.create(null) as Record<string, string>
  const forward = new Map<ToolKey, string>()
  const reverse = new Map<ToolKey, string>()

  for (const tool of tools) {
    const qualified = toolKey(tool.toolset, tool.name)
    const unqualified = toolKey(null, tool.name)
    for (const key of [qualified, unqualified]) {
      if (overrides.has(key)) {
        matched.add(key)
      }
    }
    const override = overrides.get(qualified) ?? overrides.get(unqualified)
    let patched = tool
    if (override !== undefined) {
      const result = applyOverride(tool, override)
      patched = result.tool
      issues.push(...result.issues)
    }
    const names = namesTakenIn(taken, namespaceOf(tool, collisionScope))
    if (patched.name !== tool.name) {
      // A renamed tool stops answering to its code-side name, so that name is free for a later tool to
      // rename into and must not count against this rename either. Released for the check and claimed
      // again below by whichever name wins: the new one on a rename that lands, the original on one
      // that collides. Leaving it held would refuse the valid `a -> x` then `b -> a`; releasing it
      // without claiming again would let a refused `a -> b` free `a` for a later `c -> a` and
      // advertise two tools under it.
      release(names, tool.name)
      if (names.has(patched.name) || reserved.has(patched.name)) {
        issues.push({
          section: 'tool_definitions',
          reason: 'rename-collision',
          toolset: tool.toolset ?? null,
          tool: tool.name,
          message:
            `Managed tool definition override renames ${repr(tool.name)} to ${repr(patched.name)}, ` +
            `which is already advertised by another tool; keeping the original name ${repr(tool.name)}.`,
        })
        patched = { ...patched, name: tool.name }
      }
      claim(names, patched.name)
    }
    // A tool that did not rename still holds the name the fill above claimed for it, so there is
    // nothing to release and nothing to claim again.
    applied.push(patched)
    if (!Object.hasOwn(routes, patched.name)) {
      routes[patched.name] = tool.name
    }
    forward.set(qualified, patched.name)
    reverse.set(toolKey(tool.toolset, patched.name), tool.name)
  }

  for (const key of overrides.keys()) {
    if (matched.has(key)) {
      continue
    }
    const [toolset, name] = splitToolKey(key)
    issues.push({
      section: 'tool_definitions',
      reason: 'unknown-tool',
      toolset,
      tool: name,
      message:
        `Managed agent config patches ${describeToolKey(key)}, which no toolset advertises for ` +
        'this request; that override applies to nothing.',
    })
  }
  return { tools: applied, routes, forward, reverse, issues }
}
