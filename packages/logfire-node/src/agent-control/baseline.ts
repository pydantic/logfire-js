/**
 * Building the code-side baseline: an `AgentConfig` that describes the agent as written.
 *
 * The baseline is published to the variable's `example`, which the Logfire UI shows as the thing a
 * managed value is layered onto. Nothing ever resolves it -- which is exactly what lets it use the
 * same fields to say *what exists* rather than *what to change*.
 */

import { canonicalSettings } from './config'
import type { AgentConfig, InstructionBlockConfig, ParameterOverride, ToolDefinitionOverride } from './config'
import type { InstructionBlock } from './instructions'
import type { ToolDef } from './tools'

/** What an adapter snapshots off one assembled request to describe the agent. */
export interface BaselineInput {
  /**
   * The instruction blocks the framework assembled, before any managed value reached them.
   *
   * Snapshotted per block rather than as the joined prompt, because the seams are the whole reason
   * the UI can offer an override at all: a baseline built from the joined text could only ever be
   * copied wholesale, which -- since managed instructions *add* -- is how you get the agent's own
   * text sent to the model twice with a frozen `Today is <date>` in the middle of it.
   */
  instructions?: readonly InstructionBlock[]
  /** The model the agent would use, in `'provider:model'` form. */
  model?: string | null
  /**
   * The settings the agent would run with, as a flat mapping.
   *
   * Filtered here to the canonical keys, and that filtering is load-bearing rather than tidiness: a
   * framework's settings also carry provider-specific keys and things like extra headers and bodies
   * -- exactly where authorization headers and signed request bodies live -- and a baseline is
   * published to a variable every project member can read.
   */
  settings?: Readonly<Record<string, unknown>> | null
  /** The tools the framework advertises, with their code-defined definitions. */
  tools?: readonly ToolDef[]
}

/**
 * Build the `AgentConfig` that describes the code-side agent.
 *
 * What comes back is a plain object whose keys are in contract order and whose unset fields are
 * absent rather than `null`, so `JSON.stringify(baseline, null, 2)` is the exact `example` the
 * reference implementation publishes.
 *
 * A dynamic block contributes only its seam -- its `id` and `dynamic: true`, never its text --
 * because that text is this request's rendering, built from whatever the run carried (a tenant name,
 * a user id, a retrieved document), and the baseline is readable by every member of the project. The
 * seam is what the editor needs anyway: enough to show the block is there and that it is not yours
 * to change.
 *
 * Two things are left out. A *static* block with blank text, which has nothing to describe. And a
 * dynamic block with no `id`, which an editor could neither show nor address. Note which case is not
 * on that list: a dynamic block with an `id` and blank text is published, because its text was never
 * going to be published anyway, so blankness says nothing about whether the block is worth naming.
 * An adapter whose framework renders dynamic text inside a binary it cannot read has only the seam
 * to give, and the seam is the whole contribution.
 *
 * The snapshot is a sample, not a description. For instructions or a toolset that vary with the
 * run's input, it is one point in time, which is why the reference implementation takes it from the
 * first request in a process rather than from live traffic.
 */
export function buildBaseline(input: BaselineInput): AgentConfig {
  const baseline: AgentConfig = {}

  const instructions: InstructionBlockConfig[] = []
  for (const block of input.instructions ?? []) {
    // `dynamic` is decided first, and the blank-text guard applies only to the static branch. A
    // dynamic block's text is never published, so whether it happens to be blank says nothing about
    // whether the block is worth describing -- and an adapter whose framework renders its dynamic
    // text inside a binary it cannot read (Codex, the Claude Agent SDK) has only the seam to give.
    // Guarding on text first would erase from the baseline exactly the blocks whose existence the
    // editor has no other way to learn about.
    if (block.dynamic) {
      // A dynamic block with nothing to key it on is left out entirely: an editor can neither show
      // nor address it, and its text is not ours to publish.
      if (block.id !== null) {
        instructions.push(entry(block.id, undefined, true))
      }
      continue
    }
    if (block.text.trim() === '') {
      continue
    }
    instructions.push(entry(block.id, block.text, false))
  }
  if (instructions.length > 0) {
    baseline.instructions = instructions
  }

  if (input.model !== undefined && input.model !== null) {
    baseline.model = input.model
  }

  const settings = input.settings === undefined || input.settings === null ? {} : canonicalSettings(input.settings)
  if (Object.keys(settings).length > 0) {
    baseline.settings = settings
  }

  const toolDefinitions = (input.tools ?? []).map(toolEntry)
  if (toolDefinitions.length > 0) {
    baseline.tool_definitions = toolDefinitions
  }

  return baseline
}

/** One instruction entry, with its keys in the order the contract declares them. */
function entry(id: string | null, text: string | undefined, dynamic: boolean): InstructionBlockConfig {
  const block: InstructionBlockConfig = {}
  if (id !== null) {
    block.id = id
  }
  if (text !== undefined) {
    block.instructions = text
  }
  block.dynamic = dynamic
  return block
}

/** One tool entry, with its keys in the order the contract declares them. */
function toolEntry(tool: ToolDef): ToolDefinitionOverride {
  const definition: ToolDefinitionOverride = { name: tool.name }
  if (tool.description !== undefined && tool.description !== '') {
    definition.description = tool.description
  }
  const parameters = parameterDescriptions(tool)
  if (parameters !== undefined) {
    definition.parameters = parameters
  }
  if (tool.toolset !== undefined && tool.toolset !== null) {
    definition.toolset = tool.toolset
  }
  return definition
}

/**
 * Every top-level parameter the editor may describe, documented in code or not.
 *
 * Only descriptions, because only descriptions are overridable: a baseline says what a managed value
 * could change, and a parameter's name, type, and requiredness are not among them. But *every*
 * parameter is listed, carrying its description when the code has one and an empty entry when it does
 * not -- and the empty entry is the point. An undocumented parameter is exactly the one somebody
 * wants to describe from Logfire, and a baseline that listed only the documented ones would hide it
 * from the editor until it had been documented in code first.
 */
function parameterDescriptions(tool: ToolDef): Record<string, ParameterOverride> | undefined {
  const properties = tool.parametersJsonSchema['properties']
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined
  }
  const parameters: Record<string, ParameterOverride> = {}
  for (const [name, schema] of Object.entries(properties as Record<string, unknown>)) {
    // A parameter whose schema is not an object -- JSON Schema's bare `true`, say -- still exists and
    // is still describable, so it is listed with nothing to describe it yet rather than dropped.
    const description =
      typeof schema === 'object' && schema !== null && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)['description']
        : undefined
    parameters[name] = typeof description === 'string' ? { description } : {}
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined
}
