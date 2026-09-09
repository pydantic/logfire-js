/**
 * The AI SDK's tool definitions, as the core's `ToolDef`s, and the renaming that has to follow one.
 *
 * The AI SDK looks a returned `toolName` up in the code-side `tools` record to decide what to run
 * (`ai/src/generate-text/parse-tool-call.ts`). A name it does not find is not an error in v7 -- the
 * call is marked invalid, a `tool-error` is fed back to the model, and the tool never executes -- so
 * a rename that is not mapped back does not fail loudly, it silently stops working. Every rename
 * therefore has four halves, and this module owns all of them: rename on the way out, rewrite the
 * outgoing name selectors that named the old one, un-rename the calls that come back, and re-rename
 * the history the SDK writes with code names.
 */

import type { AgentConfig, OnUnmatched, ToolDef } from '@pydantic/logfire-node/agent-control'
import { applyToolDefinitions } from '@pydantic/logfire-node/agent-control'
import type {
  JSONSchema7,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolChoice,
} from '@ai-sdk/provider'

/** The tools of a request, as the AI SDK hands them to a model. */
type CallTools = NonNullable<LanguageModelV4CallOptions['tools']>

/** What `applyToTools` gives the middleware back. */
export interface AppliedTools {
  /** The tools to advertise, in the order they were given. */
  tools: CallTools
  /** Advertised name to code-side name, for every function tool: the way back in. */
  routes: Record<string, string>
  /**
   * Code-side name to advertised name, for the tools whose name actually changed: the way out.
   *
   * Only the renames, because every use of it rewrites something -- a `toolChoice`, a replayed
   * history entry -- and an entry mapping a name to itself would make every such rewrite look like a
   * rename and cost a copy of the prompt for nothing.
   */
  renames: Record<string, string>
}

function isFunctionTool(tool: CallTools[number]): tool is LanguageModelV4FunctionTool {
  return tool.type === 'function'
}

/**
 * One tool's LLM-facing definition, as the core models it.
 *
 * `toolset` is deliberately never set. The AI SDK's `tools` is one flat `Record<string, Tool>` with
 * no grouping of any kind -- MCP tools are merged into the same record by `client.tools()` -- so
 * there is no honest value to report, and inventing one would put a name in the Logfire editor that
 * an override could be written against and would then match nothing.
 */
export function toolDefs(tools: CallTools | undefined): ToolDef[] {
  return (tools ?? []).filter(isFunctionTool).map((tool) => {
    const def: ToolDef = { name: tool.name, parametersJsonSchema: asJsonSchema(tool.inputSchema) }
    if (tool.description !== undefined) {
      def.description = tool.description
    }
    return def
  })
}

/**
 * Apply the `tool_definitions` section to a request's tools.
 *
 * Provider-defined tools pass through untouched -- their name and arguments are a contract with the
 * provider, not a description the model reads -- but their names are handed to the core as
 * `reserved`, because a managed rename onto one of them would advertise two tools under one name and
 * make both unreachable. That is the one collision the core cannot see for itself, since it is never
 * shown these tools; naming them is what lets it refuse the rename under the caller's `onUnmatched`
 * policy alongside every other collision, rather than in a warning of this adapter's own.
 *
 * `collisionScope` is the default `'global'`, stated rather than inherited: the AI SDK advertises one
 * flat namespace, so any two tools with the same name collide and there is no toolset to narrow by.
 */
export function applyToTools(tools: CallTools | undefined, config: AgentConfig, onUnmatched: OnUnmatched): AppliedTools {
  const defs = toolDefs(tools)
  const applied = applyToolDefinitions(defs, config, {
    onUnmatched,
    reserved: (tools ?? []).filter((tool) => !isFunctionTool(tool)).map((tool) => tool.name),
    collisionScope: 'global',
  })

  // The core returns the definitions in the order it was given them, so each one belongs to the
  // function tool at the same offset -- keyed back by code-side name, since that is what survives.
  // A lookup that misses is a provider-defined tool, which was never handed to the core at all.
  const definitions = new Map(defs.map((def, index) => [def.name, applied.tools[index]]))
  const routes: Record<string, string> = {}
  const renames: Record<string, string> = {}
  // A managed definition is applied to a copy: the request's tools belong to the caller.
  const result: CallTools = (tools ?? []).map((tool) => {
    const definition = isFunctionTool(tool) ? definitions.get(tool.name) : undefined
    if (definition === undefined) {
      return tool
    }
    // The core has already decided the advertised name, collisions with a provider tool included.
    const name = definition.name
    routes[name] = tool.name
    if (name !== tool.name) {
      renames[tool.name] = name
    }
    return {
      ...tool,
      name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      inputSchema: asInputSchema(definition.parametersJsonSchema),
    }
  })
  return { tools: result, routes, renames }
}

/**
 * The code-side name a call under `name` belongs to.
 *
 * `routes` covers every function tool, so a lookup that misses is a name this adapter never
 * advertised -- a provider-defined tool, or a tool the model invented -- and has to be left exactly
 * as it is for the SDK's own handling of it.
 */
function codeName(routes: Record<string, string>, name: string): string {
  return routes[name] ?? name
}

/**
 * A forced tool choice, rewritten to name the tool as the model will be shown it.
 *
 * `toolChoice: {type: 'tool', toolName: 'get_weather'}` is a decision the *code* made, expressed in
 * the code's vocabulary; an overlay that renames the tool has to carry that decision across rather
 * than leave it naming a tool this request no longer advertises, which providers reject outright.
 * The other three choices name no tool and pass through.
 *
 * `activeTools` is the sibling selector, and it is deliberately not here: the AI SDK applies it
 * before a model middleware runs -- it filters the `tools` record on the way to the request -- so
 * what reaches this seam is already the filtered set, keyed by code names that were never renamed.
 */
export function renameToolChoice(toolChoice: LanguageModelV4ToolChoice, renames: Record<string, string>): LanguageModelV4ToolChoice {
  if (toolChoice.type !== 'tool') {
    return toolChoice
  }
  const renamed = renames[toolChoice.toolName]
  return renamed === undefined ? toolChoice : { ...toolChoice, toolName: renamed }
}

/**
 * Rewrite the tool names in a prompt's history through `renames`.
 *
 * Needed on the way out because the SDK writes the assistant's `tool-call` and the `tool-result` back
 * into the next step's prompt under the *code* name, while the tools advertised alongside them carry
 * the managed name. A provider shown a call to a tool it was not offered rejects the request -- and
 * short of that, the names alternating between steps busts the prompt cache on every one of them.
 */
export function renameHistory(prompt: LanguageModelV4Prompt, renames: Record<string, string>): LanguageModelV4Prompt {
  if (Object.keys(renames).length === 0) {
    return prompt
  }
  return prompt.map((message) => renameMessage(message, renames))
}

function renameMessage(message: LanguageModelV4Message, renames: Record<string, string>): LanguageModelV4Message {
  if (message.role !== 'assistant' && message.role !== 'tool') {
    return message
  }
  // `content` is a union of part arrays per role; every part that names a tool names it the same way,
  // and every other part -- text, reasoning, a call to a tool no override renamed -- passes through.
  const content = message.content.map((part) => {
    const renamed = 'toolName' in part ? renames[part.toolName] : undefined
    return renamed === undefined ? part : { ...part, toolName: renamed }
  })
  return { ...message, content } as LanguageModelV4Message
}

/** Map the tool names in a generate result's content back to the code-side names. */
export function unrenameContent(content: readonly LanguageModelV4Content[], routes: Record<string, string>): LanguageModelV4Content[] {
  return content.map((part) => ('toolName' in part ? { ...part, toolName: codeName(routes, part.toolName) } : part))
}

/**
 * Map the tool names in a stream part back to the code-side name.
 *
 * `tool-input-start` and `tool-call` are the parts that carry one on the way in, and a
 * provider-executed `tool-result` on the way back; `tool-input-delta` and `tool-input-end` carry only
 * the id. Keying on the presence of `toolName` rather than on a list of part types is what keeps a
 * part type added in a later AI SDK release from quietly going unmapped.
 */
export function unrenameStreamPart(part: LanguageModelV4StreamPart, routes: Record<string, string>): LanguageModelV4StreamPart {
  return 'toolName' in part ? { ...part, toolName: codeName(routes, part.toolName) } : part
}

/**
 * A tool's JSON Schema as the core's `JsonSchema`, and back.
 *
 * `JSONSchema7` is an interface with named fields and `JsonSchema` is `Record<string, unknown>`, so
 * neither is assignable to the other without going through `unknown` -- but they describe the same
 * document, and the core only ever reads and rewrites `properties.*.description` inside it.
 */
function asJsonSchema(schema: JSONSchema7): Record<string, unknown> {
  return schema as unknown as Record<string, unknown>
}

function asInputSchema(schema: Record<string, unknown>): JSONSchema7 {
  return schema as unknown as JSONSchema7
}
