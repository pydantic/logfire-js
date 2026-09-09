/**
 * Mapping the tools Mastra hands the step hook onto tool definitions, and back.
 *
 * The one thing to know about Mastra's tools is that the **record key is the name the model sees**.
 * `prepareToolsAndToolChoice` builds each function declaration from the key, filters `activeTools` by
 * it, passes a `toolChoice` through under it, and routes the model's call back through it -- so the
 * key is not only an advertisement, it is the name every hook context, span and stored thread message
 * records a call under.
 *
 * That is why a managed rename is *not* done here. Re-keying the record would advertise the new name
 * and route the call, but it would rewrite the name your own code sees along with it. The record
 * keeps its code-side keys and only descriptions and parameter descriptions are overlaid onto it; the
 * rename happens one layer down, at the model boundary, in `./renaming.ts`.
 */

import { isProviderDefinedTool } from '@mastra/core/tools'
import type { JsonSchema, ToolDef } from '@pydantic/logfire-node/agent-control'

/** The tool record `ProcessInputStepArgs` carries and `ProcessInputStepResult` accepts. */
export type ToolRecord = Record<string, unknown>

/** What a step advertises: the tools an override may patch, and the names it may not take. */
export interface AdvertisedTools {
  /** The definitions a managed config is applied to, in record order, named as the code names them. */
  definitions: ToolDef[]
  /**
   * Advertised names that are not this adapter's to touch, which a rename must not collide with.
   *
   * Mastra's tool record may also hold *provider-defined* tools -- `google.tools.googleSearch()` and
   * its kind -- whose name is a contract with the provider rather than a description the model reads,
   * and which Mastra advertises under the tool's own `name` rather than the record key. So they are
   * neither patched nor renamed, and their advertised names go to the core as reserved: a managed
   * rename onto one of them would put two tools on the wire under one name and make both unreachable.
   */
  reserved: string[]
}

/**
 * Read the LLM-facing definition of each tool the step advertises.
 *
 * By the time a processor sees them, Mastra has assembled every source into one flat record -- the
 * agent's own tools, plus memory, workspace, skill, sub-agent, workflow and MCP tools -- and built
 * each one into a `CoreTool` whose `parameters.jsonSchema` is what the provider is sent. There is no
 * source label on the built tool, so no `toolset` is reported: an override matches by name alone.
 */
export function readTools(tools: ToolRecord): AdvertisedTools {
  const definitions: ToolDef[] = []
  const reserved: string[] = []
  for (const [name, tool] of Object.entries(tools)) {
    if (isProviderDefinedTool(tool)) {
      reserved.push(advertisedName(tool, name))
      continue
    }
    const description = (tool as { description?: unknown }).description
    const def: ToolDef = { name, parametersJsonSchema: parametersOf(tool) }
    if (typeof description === 'string') {
      def.description = description
    }
    definitions.push(def)
  }
  return { definitions, reserved }
}

/**
 * The name a provider-defined tool is advertised under.
 *
 * `prepareToolsAndToolChoice` sends `tool.name ?? recordKey`, so the record key is its wire name only
 * when the tool carries none of its own.
 */
function advertisedName(tool: object, key: string): string {
  const name = (tool as { name?: unknown }).name
  return typeof name === 'string' ? name : key
}

/**
 * Overlay the applied definitions onto the tool record, under the keys the code gave them.
 *
 * `applied` comes back from the core in the order it was handed `definitions`, so the two are zipped
 * by position, and each patch is written under the *code-side* key -- never under a managed
 * `new_name`. Every entry the core was not shown, a provider-defined tool included, is carried
 * through untouched.
 *
 * Returns the record it was given when nothing changed, so a caller can tell an applied config from
 * one that reached nothing and leave the step alone.
 */
export function applyToTools(tools: ToolRecord, definitions: readonly ToolDef[], applied: readonly ToolDef[]): ToolRecord {
  const patches = new Map<string, ToolDef>()
  for (const [index, def] of definitions.entries()) {
    const result = applied[index]
    // A shorter `applied` than `definitions` is not a shape the core returns; skipping is what keeps
    // that from being read as "this tool's definition is the one at the wrong index".
    if (result !== undefined) {
      patches.set(def.name, result)
    }
  }
  const original = Object.entries(tools)
  const entries = original.map(([name, tool]): [string, unknown] => {
    const def = patches.get(name)
    return [name, def === undefined ? tool : patch(tool, def)]
  })
  if (entries.every(([, tool], index) => tool === original[index]?.[1])) {
    return tools
  }
  // `Object.fromEntries` rather than assignment in a loop, because `rebuilt[name] = tool` for a tool
  // keyed `__proto__` -- which a record built with a computed key can carry, and which is a name
  // every provider's function-name grammar allows -- runs the prototype setter instead of creating a
  // property, and the tool would vanish from every request a config was applied to.
  return Object.fromEntries(entries)
}

/** Overlay a definition's description and parameter schema onto one built tool, or return it unchanged. */
function patch(tool: unknown, def: ToolDef): unknown {
  const original = tool as { description?: unknown; parameters?: { jsonSchema?: unknown }; inputSchema?: unknown }
  const describes = def.description !== undefined && def.description !== original.description
  const schema = def.parametersJsonSchema !== parametersOf(tool) ? def.parametersJsonSchema : undefined
  if (!describes && schema === undefined) {
    return tool
  }
  const patched: Record<string, unknown> = { ...(original as Record<string, unknown>) }
  if (describes) {
    patched['description'] = def.description
  }
  if (schema !== undefined) {
    // A built `CoreTool` carries `parameters: { jsonSchema, validate }`, where only `jsonSchema` is
    // sent to the provider and `validate` still checks the arguments against the code-defined shape --
    // which is why an override may rewrite descriptions but never the schema's structure. A tool that
    // reached the step unbuilt (a plain AI SDK tool) carries its JSON schema as `inputSchema` instead.
    if (isRecord(original.parameters)) {
      patched['parameters'] = { ...original.parameters, jsonSchema: schema }
    } else {
      patched['inputSchema'] = schema
    }
  }
  return patched
}

/** The JSON Schema a tool advertises, or an empty schema when it is in a form this adapter cannot read. */
function parametersOf(tool: unknown): JsonSchema {
  const candidate = tool as { parameters?: { jsonSchema?: unknown }; inputSchema?: unknown }
  const jsonSchema = candidate.parameters?.jsonSchema
  if (isRecord(jsonSchema)) {
    return jsonSchema
  }
  // An unbuilt tool's `inputSchema` is either a JSON schema already or a Standard Schema object (a
  // Zod schema, say). Only the first is readable without knowing which validation library wrote it,
  // and `~standard` is how the standard says to tell them apart.
  const inputSchema = candidate.inputSchema
  if (isRecord(inputSchema) && !('~standard' in inputSchema)) {
    return inputSchema
  }
  return EMPTY_SCHEMA
}

/**
 * The schema reported for a tool whose parameters cannot be read.
 *
 * One shared frozen object, so `parametersOf` returns the same reference every time it is asked about
 * such a tool and `patch` can tell "the helper changed nothing" from "the helper rewrote it" by
 * identity, exactly as it does for a schema that was readable.
 */
const EMPTY_SCHEMA: JsonSchema = Object.freeze({})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
