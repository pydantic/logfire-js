/**
 * The `AgentConfig` contract and the lenient parsing that turns a published value into it.
 *
 * # Why the field names are `snake_case`
 *
 * The types in this module are the *wire* shape: what is stored in the Logfire variable, what the
 * Logfire UI edits, and what `AGENT_CONFIG_JSON_SCHEMA` validates. Renaming `tool_definitions` to
 * `toolDefinitions` for the sake of TypeScript convention would put a translation layer between this
 * package and the only artifact it exists to agree with, and give the two somewhere to drift. The
 * adapter-facing types that never reach the wire -- `InstructionBlock`, `ToolDef`, every options bag
 * -- are `camelCase`, because nothing outside this process ever sees them.
 *
 * # Why parsing is lenient
 *
 * A managed value is resolved on every run through the SDK's variable machinery, which falls back to
 * the code default when parsing throws. So a strict parse does not mean "reject the bad field", it
 * means "revert the agent's instructions, model, settings, and every tool override to code because
 * one key was unfamiliar". Every parser here therefore degrades the narrowest unit that contains the
 * problem -- one setting, one instruction entry, one tool override -- warns about exactly that unit,
 * and keeps its siblings.
 */

import { z } from 'zod'

import { codePointLength, MAX_MODEL_FACING_TEXT_LENGTH } from './schema'
import { isRepresentableTimeout, MAX_TIMEOUT_SECONDS } from './units'
import { repr, warnOnce } from './warnings'

/**
 * Where the settings keys a published value asked for and this release has no field for are kept.
 *
 * A symbol rather than a field because it is not part of the value: it is what the value asked for
 * that this SDK could not do, which only `applySettings` has any use for. `JSON.stringify` ignores
 * symbol-keyed properties outright, so a parsed config still serializes back to exactly the contract
 * -- which matters, since a baseline is published by serializing one of these.
 *
 * Not exported from the package index: an adapter gets this reported for it by `applySettings`.
 */
export const UNRECOGNIZED_SETTINGS: unique symbol = Symbol('logfire.agentControl.unrecognizedSettings')

/**
 * Where the top-level keys a published value asked for and this release has no section for are kept.
 *
 * The same mechanism as `UNRECOGNIZED_SETTINGS`, one level up, and for the same reason: ignoring a
 * key this release has no section for is what lets a future `mcp_servers` or `skills` section be
 * published against an older SDK, and saying so is what stops the first person who does it from
 * getting a silently degraded agent. A symbol, so a parsed config still serializes back to exactly
 * the contract.
 *
 * Not exported from the package index: an adapter gets these reported for it by `applySettings`.
 */
export const UNRECOGNIZED_SECTIONS: unique symbol = Symbol('logfire.agentControl.unrecognizedSections')

/** The top-level keys this release has a section for; everything else is remembered and reported. */
const SECTION_KEYS: readonly string[] = ['instructions', 'model', 'settings', 'tool_definitions']

/**
 * Canonical model settings managed as one section of an `AgentConfig`.
 *
 * The keys are the contract: the settings every framework Agent Control drives has a knob for, under
 * the names Pydantic AI's `ModelSettings` gives them, so a published value lowers into any SDK
 * without translation and means the same thing to each. Unset keys keep their code-defined values.
 * The model itself is the sibling `model` field on `AgentConfig`.
 *
 * Nothing else gets through. A key this SDK has no field for is dropped rather than forwarded -- a
 * key it does not understand is not one it can lower into a request -- and remembered under
 * `UNRECOGNIZED_SETTINGS` so `applySettings` can report it, since a newer UI's key that this SDK
 * quietly did nothing with is exactly the kind of gap between what Logfire shows and what the agent
 * does that has to be visible.
 */
export interface AgentConfigSettings {
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  seed?: number
  presence_penalty?: number
  frequency_penalty?: number
  parallel_tool_calls?: boolean
  timeout?: number
  stop_sequences?: string[]
  thinking?: boolean | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** The published keys this release has no field for, in the order they were written. */
  [UNRECOGNIZED_SETTINGS]?: readonly string[]
}

/** One entry in `AgentConfig.instructions`: a block to add, or a patch on a block the agent assembles. */
export interface InstructionBlockConfig {
  /**
   * The id of the instruction block to address, or absent to add a block.
   *
   * The contract keeps `id` free-form and reserves only `'agent'` as the cross-framework name for the
   * prompt as written; the rest of the namespace belongs to each adapter.
   */
  id?: string
  /**
   * The block's text, or `null` to drop the addressed block.
   *
   * `null` is how a block is disabled, which is why `''` is rejected rather than taken as a quiet way
   * to blank one: an entry meaning "send nothing here" and an entry someone left half-filled should
   * not look identical.
   */
  instructions?: string | null
  /**
   * Whether the addressed block is recomputed per request. Informational; ignored when applied.
   *
   * It earns its keep in a baseline, where it is how the Logfire UI can say that replacing a computed
   * block -- today's date, the signed-in user -- would pin whatever it happened to evaluate to when
   * the snapshot was taken.
   */
  dynamic?: boolean
}

/** A patch over one top-level parameter of a tool's LLM-facing definition. */
export interface ParameterOverride {
  /** Replacement description shown to the model; absent keeps the code-defined description. */
  description?: string
}

/**
 * A patch over a tool's LLM-facing definition.
 *
 * Overrides change only what the model is shown. Schema structure, validation, and execution remain
 * code-defined.
 */
export interface ToolDefinitionOverride {
  /** The tool's original code-side name, which is what this entry patches. */
  name: string
  /** Replacement name shown to the model; a call to it still routes back to the original tool. */
  new_name?: string
  /** Replacement description shown to the model. */
  description?: string
  /**
   * Patches per top-level parameter name.
   *
   * Unknown parameter names are ignored: a parameter is part of the tool's code-defined shape, so a
   * patch on one the tool does not have is the tool having changed, which the baseline shows.
   */
  parameters?: Record<string, ParameterOverride>
  /**
   * The toolset the tool came from: a baseline reports it, and an override narrows the match by it.
   *
   * An override that sets it applies only to that toolset's tool of this `name`, which is what lets
   * two toolsets that both advertise a `search` be patched apart; an override without it matches by
   * `name` alone, and when both match one tool the qualified entry wins.
   */
  toolset?: string
}

/**
 * The schema contract shared with the Logfire Agent Control UI.
 *
 * Every managed value is a patch on the code-defined agent. A key present in the value is managed
 * from Logfire; an absent key keeps code-defined behavior. Removing a key in Logfire is therefore a
 * deliberate revert to code.
 */
export interface AgentConfig {
  /**
   * Instruction blocks to add to -- or swap out of -- the ones the agent assembles in code.
   *
   * A bare string is exactly one added block, and is kept as written rather than rewritten into the
   * list form, so a published value stays the shape its author chose and successive versions stay
   * readable as a diff.
   */
  instructions?: string | (string | InstructionBlockConfig)[]
  /** A model string in `'provider:model'` form, such as `'anthropic:claude-fable-5-1'`. */
  model?: string
  /** Canonical model settings patch; see `AgentConfigSettings`. */
  settings?: AgentConfigSettings
  /** LLM-facing overlays, each naming the tool it patches; see `ToolDefinitionOverride`. */
  tool_definitions?: ToolDefinitionOverride[]
  /** The published top-level keys this release has no section for, in the order they were written. */
  [UNRECOGNIZED_SECTIONS]?: readonly string[]
}

/**
 * A managed string that has to say something.
 *
 * `''` is never a meaningful managed value -- not "no model", not "no instructions", just a value
 * someone left half-filled -- and absent already means "leave this to code". Rejecting it keeps the
 * two apart at every level: the stored JSON schema won't accept the write, and a value that reaches
 * an older SDK anyway degrades that one field instead of the whole config.
 */
const nonEmptyString = z.string().min(1)

// Bounded in code points rather than with Zod's `.max()`, which counts UTF-16 code units: the budget
// is a cross-language contract, and an astral character has to cost the same here as it does in the
// Python core. In practice the section-level budget below refuses an oversized entry first; this is
// what makes the bound a property of the entry schema rather than only of the loop around it.
const instructionText = z
  .string()
  .min(1)
  .refine((text) => codePointLength(text) <= MAX_MODEL_FACING_TEXT_LENGTH, {
    message: `Text must contain at most ${String(MAX_MODEL_FACING_TEXT_LENGTH)} code points`,
  })

// Every object schema here strips unknown keys rather than rejecting or keeping them, which is the
// same forward-compatibility rule the stored JSON schema follows: a key a newer UI writes must not
// fail the entry that contains it, and must not be forwarded to a framework that has no idea what it
// means either. `settings` is the one exception -- its unknown keys are remembered and reported,
// because a setting someone published and this SDK did not apply is a gap the run should say aloud.
const parameterOverrideSchema = z.object({ description: z.string().optional() })

const toolDefinitionOverrideSchema = z.object({
  name: nonEmptyString,
  new_name: nonEmptyString.optional(),
  description: z.string().optional(),
  parameters: z.record(z.string(), parameterOverrideSchema).optional(),
  toolset: z.string().optional(),
})

const instructionBlockSchema = z.object({
  id: nonEmptyString.optional(),
  instructions: instructionText.nullish(),
  dynamic: z.boolean().optional(),
})

/**
 * Per-key validators for the settings whose accepted values are open-ended.
 *
 * Split from `VERSIONED_SETTINGS` so a wrong type here reads as malformed rather than merely newer;
 * the stored schema already rejects these at write time, so one arriving is a hand-edited value.
 *
 * A `Map` rather than an object literal, and that is not style. These are looked up by a key that
 * came out of arbitrary JSON, and `PLAIN_SETTINGS['constructor']` on an object literal answers with
 * `Object.prototype`'s -- a function with no `safeParse`, which turns one hostile or merely odd
 * settings key into a `TypeError` thrown out of the parse, which the SDK's resolution then reads as
 * "nothing is published" and reverts the entire config to code. A `Map` has no inherited entries to
 * find. The same is true of `VERSIONED_SETTINGS` below.
 */
const PLAIN_SETTINGS = new Map<string, z.ZodType>([
  ['max_tokens', z.number().int()],
  ['temperature', z.number()],
  ['top_p', z.number()],
  ['top_k', z.number().int()],
  ['seed', z.number().int()],
  ['presence_penalty', z.number()],
  ['frequency_penalty', z.number()],
  ['parallel_tool_calls', z.boolean()],
  ['timeout', z.number()],
  ['stop_sequences', z.array(z.string())],
])

/**
 * Per-key validators for the settings whose accepted values grow from release to release.
 *
 * A key that enumerates what *this* release knows about is the one that can be handed a value a
 * newer UI wrote and this SDK cannot lower, which is a different failure from a structurally wrong
 * value and gets a different warning. `thinking` is the only one today.
 */
const VERSIONED_SETTINGS = new Map<string, z.ZodType>([
  ['thinking', z.union([z.boolean(), z.enum(['minimal', 'low', 'medium', 'high', 'xhigh'])])],
])

/** Every key an `AgentConfigSettings` has a field for, in the order the contract declares them. */
export const CANONICAL_SETTINGS_KEYS = [...PLAIN_SETTINGS.keys(), ...VERSIONED_SETTINGS.keys()] as readonly (keyof AgentConfigSettings &
  string)[]

/**
 * A framework's own settings reduced to the contract's canonical keys and describable values.
 *
 * What a baseline may say about the code side, and nothing more. Two filters, and both are
 * load-bearing rather than tidiness:
 *
 * - **Keys.** A framework's settings also carry provider-specific ones and things like extra headers
 *   and bodies -- exactly where authorization headers and signed request bodies live -- and a
 *   baseline is published to a variable every member of the Logfire project can read. A key with no
 *   field here is dropped in silence, because it is the agent's own setting rather than anything
 *   anyone published.
 * - **Values.** A value the contract has a key for but cannot hold is left out and warned about,
 *   never approximated. A reasoning effort a framework spells `'max'` is not `'xhigh'`, and
 *   publishing it as one describes the code as doing something it does not do, in the one artifact
 *   the Logfire editor presents as the truth about the code. A timeout outside the representable
 *   range goes the same way.
 *
 * The Python core reads these leniently and a *published* value strictly, because its two directions
 * disagree about whether an `int` is a `float` and a tuple is a list. TypeScript has one number type
 * and one sequence type, so the same validators serve both here; what does not change is that a code
 * value the contract cannot hold is reported and omitted rather than coerced into the nearest thing
 * that fits.
 *
 * Keys come back in the order the contract declares them, not the order the framework happened to
 * hold them in, so the `example` this ends up in is byte-identical whichever SDK published it.
 */
export function canonicalSettings(settings: Readonly<Record<string, unknown>>): AgentConfigSettings {
  const describable = new Map<string, unknown>()
  for (const [name, value] of Object.entries(settings)) {
    const validator = PLAIN_SETTINGS.get(name) ?? VERSIONED_SETTINGS.get(name)
    if (validator === undefined || value === undefined || value === null) {
      continue
    }
    if (name === 'timeout' && typeof value === 'number' && !isRepresentableTimeout(value)) {
      warnOnce(
        `The agent runs with a request timeout of ${repr(value)} seconds, which the Agent Control ` +
          `contract cannot describe -- it has to be finite, not negative, and no larger than ` +
          `${String(MAX_TIMEOUT_SECONDS)} seconds; leaving it out of the published baseline.`
      )
      continue
    }
    const result = validator.safeParse(value)
    if (result.success) {
      describable.set(name, result.data)
    } else {
      warnOnce(
        `The agent runs with ${name}=${repr(value)}, which the Agent Control contract cannot describe; ` +
          'leaving it out of the published baseline.'
      )
    }
  }
  const canonical: Record<string, unknown> = {}
  for (const key of CANONICAL_SETTINGS_KEYS) {
    if (describable.has(key)) {
      canonical[key] = describable.get(key)
    }
  }
  return canonical as AgentConfigSettings
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the settings section, dropping each key this SDK cannot act on independently.
 *
 * Three outcomes per key, each with its own message because each is a different thing to fix: a key
 * with no field here is *unrecognized* and remembered for `applySettings` to report; an enumerated
 * key with a value this release does not know is *newer*; anything else that fails is *malformed*.
 */
function parseSettings(data: unknown): AgentConfigSettings | undefined {
  if (!isPlainObject(data)) {
    if (data === undefined || data === null) {
      return undefined
    }
    warnOnce(
      `Managed settings section has invalid container ${repr(data)}; ignoring that section and keeping the rest of the managed config.`
    )
    return undefined
  }
  const settings: Record<string, unknown> = {}
  const unrecognized: string[] = []
  for (const [name, value] of Object.entries(data)) {
    const versioned = VERSIONED_SETTINGS.get(name)
    if (versioned !== undefined) {
      if (versioned.safeParse(value).success) {
        settings[name] = value
      } else {
        warnOnce(
          `Managed agent config sets ${repr(name)} to ${repr(value)}, which this version of the SDK does not ` +
            'recognize; ignoring that setting and keeping the rest of the managed config.'
        )
      }
      continue
    }
    const plain = PLAIN_SETTINGS.get(name)
    if (plain === undefined) {
      unrecognized.push(name)
      continue
    }
    if (plain.safeParse(value).success) {
      settings[name] = value
    } else {
      warnOnce(
        `Managed agent config setting ${repr(name)} has invalid value ${repr(value)}; ignoring that setting ` +
          'and keeping the rest of the managed config.'
      )
    }
  }
  const parsed = settings as AgentConfigSettings
  if (unrecognized.length > 0) {
    Object.defineProperty(parsed, UNRECOGNIZED_SETTINGS, {
      value: Object.freeze(unrecognized),
      enumerable: false,
    })
  }
  return parsed
}

/**
 * Render one rejected entry's failure -- offending field, value, and reason -- for a warning.
 *
 * `whole` names the entry itself, for a failure that is not about any one field (something that is
 * not an object at all): the two sections share this renderer, so neither may be labelled with the
 * other's noun.
 */
function entryErrors(error: z.ZodError, input: unknown, whole: string): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || whole}=${repr(getIn(input, issue.path))} (${issue.message})`)
    .join('; ')
}

/**
 * Follow a Zod issue's path into the value it was reported against.
 *
 * `Object(value)` rather than a traversability check, so a path that does not resolve comes back
 * `undefined` instead of throwing: this only ever runs to build a warning about something that was
 * already wrong, and a formatter that can throw would turn a dropped entry into a failed parse.
 */
function getIn(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input
  for (const key of path) {
    value = (Object(value) as Record<PropertyKey, unknown>)[key]
  }
  return value
}

/**
 * Validate the instructions section, dropping an entry that does not validate.
 *
 * An entry is the natural unit of degradation: each one adds or addresses exactly one block, so an
 * entry this SDK cannot make sense of -- an empty string where text was meant, an entry that says
 * neither what nor where, something that is neither a string nor an object -- can be left out while
 * every other block still applies.
 *
 * A bare string is left whole: it is one block by definition, so there is no sibling to save by
 * rescuing it, and preserving the shape keeps a published value looking the way its author wrote it.
 */
function parseInstructions(data: unknown): AgentConfig['instructions'] {
  if (typeof data === 'string') {
    if (codePointLength(data) > MAX_MODEL_FACING_TEXT_LENGTH) {
      warnOnce(
        `Managed instructions section contains ${String(codePointLength(data))} characters, exceeding the ` +
          `${String(MAX_MODEL_FACING_TEXT_LENGTH)}-character limit; ignoring that section and keeping the rest ` +
          `of the managed config.`
      )
      return undefined
    }
    if (data.length === 0) {
      warnOnce(
        "Managed instructions section is invalid -- instructions=''; ignoring that section and keeping the rest of the managed config."
      )
      return undefined
    }
    return data
  }
  if (!Array.isArray(data)) {
    if (data !== undefined && data !== null) {
      warnOnce(
        `Managed instructions section has invalid container ${repr(data)}; ignoring that section and ` +
          'keeping the rest of the managed config.'
      )
    }
    return undefined
  }
  const blocks: (string | InstructionBlockConfig)[] = []
  // The bound is on the text this section adds to every model request, so it has to be the total
  // across entries, not just each one: a section written as one string is capped, and the same text
  // written as ten entries has to be capped too or the limit means nothing. Only text that actually
  // survives is charged against it -- an entry dropped for being malformed adds nothing to the
  // request, so charging it would let one bad entry shrink the budget for the good ones, and would
  // make the entries a value keeps depend on the ones it does not.
  let remaining = MAX_MODEL_FACING_TEXT_LENGTH
  for (const entry of data as unknown[]) {
    const text = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry['instructions'] : undefined
    const length = typeof text === 'string' ? codePointLength(text) : 0
    if (typeof text === 'string' && length > remaining) {
      warnOnce(
        `Managed instruction entry contains ${String(length)} characters, which does not fit in the ` +
          `${String(remaining)} remaining of the ${String(MAX_MODEL_FACING_TEXT_LENGTH)}-character limit across all ` +
          `entries; ignoring that entry and keeping the rest of the managed config.`
      )
      continue
    }
    const candidate = typeof entry === 'string' ? { instructions: entry } : entry
    const result = instructionBlockSchema.safeParse(candidate)
    if (!result.success) {
      warnOnce(
        `Managed instruction entry ${repr(entry)} is invalid -- ${entryErrors(result.error, candidate, 'entry')}; ` +
          'ignoring that entry and keeping the rest of the managed config.'
      )
      continue
    }
    const block = result.data
    if (block.id === undefined && (block.instructions === undefined || block.instructions === null)) {
      warnOnce(
        `Managed instruction entry ${repr(entry)} has neither an \`id\` to address nor text to add; ` +
          'ignoring that entry and keeping the rest of the managed config.'
      )
      continue
    }
    remaining -= length
    blocks.push(block as InstructionBlockConfig)
  }
  return blocks
}

/**
 * Validate the tool overlays, dropping an override that does not validate.
 *
 * Each entry patches exactly one tool, so an entry this SDK cannot validate -- a missing or empty
 * `name`, a field carrying a shape it does not know, something that is not an object at all -- can
 * be left out while every other tool keeps its managed definition.
 */
function parseToolDefinitions(data: unknown): ToolDefinitionOverride[] | undefined {
  if (!Array.isArray(data)) {
    if (data !== undefined && data !== null) {
      warnOnce(
        `Managed tool definitions section has invalid container ${repr(data)}; ignoring that section and ` +
          'keeping the rest of the managed config.'
      )
    }
    return undefined
  }
  const overrides: ToolDefinitionOverride[] = []
  for (const entry of data as unknown[]) {
    const result = toolDefinitionOverrideSchema.safeParse(entry)
    if (result.success) {
      overrides.push(result.data as ToolDefinitionOverride)
    } else {
      warnOnce(
        `Managed tool definition override ${repr(entry)} is invalid -- ` +
          `${entryErrors(result.error, entry, 'override')}; ` +
          'ignoring that override and keeping the rest of the managed config.'
      )
    }
  }
  return overrides
}

/**
 * Turn a published value into an `AgentConfig`, degrading rather than failing.
 *
 * Never throws. That is the whole point: this runs inside the SDK's variable resolution, where a
 * throw is indistinguishable from "nothing is published" and would revert every section of the
 * config to code over one bad field. A value that is not an object at all is the one case with
 * nothing to salvage, and comes back as an empty config.
 */
export function parseAgentConfig(data: unknown): AgentConfig {
  if (!isPlainObject(data)) {
    if (data !== undefined && data !== null) {
      warnOnce(`Managed agent config is not an object -- ${repr(data)}; ignoring it and running on code.`)
    }
    return {}
  }
  const config: AgentConfig = {}
  const instructions = parseInstructions(data['instructions'])
  if (instructions !== undefined) {
    config.instructions = instructions
  }
  const model = data['model']
  if (model !== undefined && model !== null) {
    if (nonEmptyString.safeParse(model).success) {
      config.model = model as string
    } else {
      warnOnce(
        `Managed agent config selects invalid model ${repr(model)}; ignoring that section and keeping the rest of the managed config.`
      )
    }
  }
  const settings = parseSettings(data['settings'])
  if (settings !== undefined) {
    config.settings = settings
  }
  const toolDefinitions = parseToolDefinitions(data['tool_definitions'])
  if (toolDefinitions !== undefined) {
    config.tool_definitions = toolDefinitions
  }
  const unrecognized = Object.keys(data).filter((name) => !SECTION_KEYS.includes(name))
  if (unrecognized.length > 0) {
    Object.defineProperty(config, UNRECOGNIZED_SECTIONS, {
      value: Object.freeze(unrecognized),
      enumerable: false,
    })
  }
  return config
}
