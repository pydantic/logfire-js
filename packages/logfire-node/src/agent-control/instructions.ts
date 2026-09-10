/**
 * Applying the `instructions` section to a framework's assembled instruction blocks.
 *
 * Instructions are the one section that composes with the agent rather than patching it, which is
 * why they need a helper at all: an entry with no `id` *adds* a block, and an entry with an `id`
 * *swaps out* a block the framework already assembled. Getting the two confused is the difference
 * between a prompt that reads well and one sent to the model twice.
 */

import type { AgentConfig, InstructionBlockConfig } from './config'
import { codePointLength, MAX_MODEL_FACING_TEXT_LENGTH } from './schema'
import { reportUnappliedEntries, repr, warnOnce } from './warnings'
import type { OnUnmatched, UnappliedEntry } from './warnings'

/**
 * One instruction block as a framework assembles it, and as this package hands it back.
 *
 * The three fields are everything a managed config needs to know about a block and, per the adapter
 * reports, everything every surveyed framework can supply: what addresses it, what it says, and
 * whether it is recomputed. An adapter maps its own parts onto these, calls `applyInstructions`, and
 * maps the result back; nothing else about its instruction model has to be modelled here.
 */
export interface InstructionBlock {
  /**
   * The key a managed config addresses this block by, or `null` when nothing can address it.
   *
   * A framework gives ids to the blocks it can name and `null` to the ones it cannot -- a callable
   * that returns text, an anonymous contribution. A `null` block passes through untouched.
   */
  id: string | null
  /** The block's text. */
  text: string
  /**
   * Whether the framework recomputes this block per request.
   *
   * Load-bearing twice over. A dynamic block cannot be addressed -- replacing it would pin one
   * rendering forever and dropping it would remove the computation -- and it is what decides where
   * an added block goes, since providers cache a request's stable prefix and an added block must not
   * move that boundary.
   */
  dynamic: boolean
}

/** Options for `applyInstructions`. */
export interface ApplyInstructionsOptions {
  /**
   * What to do with a published entry this request did not apply.
   *
   * Every decision `applyInstructions` makes goes through it -- an unknown id, a dynamic one, and
   * text past the budget alike -- so `'ignore'` silences all three and `'error'` fails on all three.
   */
  onUnmatched?: OnUnmatched
}

/** What `applyInstructions` returns: the blocks to send, and what reached nothing. */
export interface AppliedInstructions {
  /** The blocks to send, with published text swapped in, removed, or added. */
  blocks: InstructionBlock[]
  /**
   * Every published instruction entry this request did not apply; see `UnappliedEntry`.
   *
   * Already reported under the caller's `onUnmatched` policy before it is returned, so this is for an
   * adapter that wants to do something *else* with them -- put them on a span, count them -- rather
   * than the way they are surfaced.
   */
  unapplied: readonly UnappliedEntry[]
}

/** One entry whose text is past the budget, refused rather than truncated. */
function oversized(text: string, remaining: number, instructionId?: string): UnappliedEntry {
  const where = instructionId === undefined ? '' : `for instruction block ${repr(instructionId)} `
  const limit =
    remaining === MAX_MODEL_FACING_TEXT_LENGTH
      ? `past the ${String(MAX_MODEL_FACING_TEXT_LENGTH)}-character limit on what this section may add to `
      : `which does not fit in the ${String(remaining)} remaining of the ${String(MAX_MODEL_FACING_TEXT_LENGTH)}-character ` +
        `limit across all entries on what this section may add to `
  return {
    reason: 'oversized-text',
    ...(instructionId === undefined ? {} : { instructionId }),
    message:
      `Managed agent config publishes instruction text ${where}of ${String(codePointLength(text))} characters, ` +
      `${limit}every model request; that entry is not applied.`,
  }
}

/**
 * The `instructions` section as a list of entries, whichever of its two shapes was written.
 *
 * A bare string is exactly one added block, so the two shapes only ever differ in how they read in
 * the Logfire editor.
 */
export function instructionEntries(config: AgentConfig): InstructionBlockConfig[] {
  const { instructions } = config
  if (instructions === undefined) {
    return []
  }
  if (typeof instructions === 'string') {
    return [{ instructions }]
  }
  return instructions.map((entry) => (typeof entry === 'string' ? { instructions: entry } : entry))
}

/**
 * Index entries by key, keeping the first of any duplicates with a warning.
 *
 * A published value can name the same block twice -- by a hand edit, or by a UI bug. Keeping the
 * first is what keeps the run predictable and lets the ignored entry be named, rather than the last
 * writer silently winning depending on how the JSON happened to be ordered.
 */
function overridesById(config: AgentConfig): Map<string, string | null> {
  const overrides = new Map<string, string | null>()
  for (const entry of instructionEntries(config)) {
    if (entry.id === undefined) {
      continue
    }
    if (overrides.has(entry.id)) {
      warnOnce(`Managed agent config names instruction id ${repr(entry.id)} more than once; keeping the first entry and ignoring the rest.`)
      continue
    }
    overrides.set(entry.id, entry.instructions ?? null)
  }
  return overrides
}

/**
 * Which entries do not fit the section's budget, decided in the order the value published them.
 *
 * The bound is on what this section adds to every model request, so it is the total across entries
 * and not just each one: the same text written as one entry and as ten has to cost the same, or the
 * limit means nothing. A typed caller reaching `applyInstructions` directly -- an adapter with its
 * own config, a test -- used to go through a per-entry check alone, so two entries at the limit both
 * applied and the request carried twice it.
 *
 * Charged in `instructionEntries` order rather than in the order the entries are *applied*, which is
 * replacements first and then additions. `parseInstructions` charges a published value in published
 * order, and the two have to agree: with a 40,000-character addition published before a
 * 40,000-character replacement, block order keeps the replacement while the parser keeps the
 * addition, so the same value would apply differently depending on whether it arrived as JSON or as
 * a typed config. Hence a pass of its own before anything is applied.
 *
 * Only text that survives is charged, as in the parser: an entry refused for the budget adds nothing
 * to the request, so charging it would let one oversized entry shrink the budget for the good ones
 * and make the entries a value keeps depend on the ones it does not. An entry that reaches no block,
 * addresses a dynamic one, or only removes text adds nothing either, so none of them is charged.
 *
 * Returns the remaining budget at the point each refused entry was measured, keyed by instruction id
 * for a replacement and by index into `added` for an addition, so the message can say how much room
 * was actually left rather than quoting the whole limit.
 */
function spendBudget(
  blocks: readonly InstructionBlock[],
  config: AgentConfig,
  overrides: ReadonlyMap<string, string | null>
): { ids: Map<string, number>; additions: Map<number, number> } {
  const byId = new Map<string, InstructionBlock>()
  for (const block of blocks) {
    if (block.id !== null && !byId.has(block.id)) {
      byId.set(block.id, block)
    }
  }
  const ids = new Map<string, number>()
  const additions = new Map<number, number>()
  const charged = new Set<string>()
  let remaining = MAX_MODEL_FACING_TEXT_LENGTH
  let index = -1
  for (const entry of instructionEntries(config)) {
    let text: string
    if (entry.id === undefined) {
      if (typeof entry.instructions !== 'string') {
        continue
      }
      index += 1
      text = entry.instructions
    } else {
      // Only the first entry naming an id is applied, so only the first is charged.
      if (charged.has(entry.id)) {
        continue
      }
      charged.add(entry.id)
      const replacement = overrides.get(entry.id)
      const block = byId.get(entry.id)
      if (typeof replacement !== 'string' || block === undefined || block.dynamic) {
        continue
      }
      text = replacement
    }
    const length = codePointLength(text)
    if (length > remaining) {
      if (entry.id === undefined) {
        additions.set(index, remaining)
      } else {
        ids.set(entry.id, remaining)
      }
      continue
    }
    remaining -= length
  }
  return { ids, additions }
}

/**
 * Where an added block goes: before the first dynamic block, or at the end when there is none.
 *
 * Frameworks that care about prompt caching group static text ahead of dynamic text so the provider
 * can cache the stable prefix, so this lands an added block at the end of the static group -- after
 * the last static block and before the first dynamic one -- and moves no existing block. On input
 * that is not grouped that way, landing before the first dynamic block is still the choice that
 * cannot push cached text past the boundary.
 */
function insertionIndex(blocks: readonly InstructionBlock[]): number {
  const firstDynamic = blocks.findIndex((block) => block.dynamic)
  return firstDynamic === -1 ? blocks.length : firstDynamic
}

/**
 * Apply a managed config's `instructions` section to a request's assembled blocks.
 *
 * Pure: it reads `blocks` and returns a new list, so an adapter can call it from whatever hook its
 * framework gives it and hand the result straight back.
 *
 * - An entry **with an `id`** replaces that block's text, or removes the block when `instructions` is
 *   `null`. The block's position and its `dynamic` flag are carried over untouched -- re-flagging a
 *   replaced block would move the provider's cache boundary for every request, a silent cost
 *   regression in exchange for nothing.
 * - An entry that addresses a **dynamic** block is refused and reported: its text is recomputed per
 *   request, so replacing it pins one rendering and dropping it removes the computation, and nothing
 *   about the managed value says which was meant.
 * - An entry with **no `id`** adds a static block at the end of the static group; see
 *   `insertionIndex`.
 * - An `id` that **matches no block** applies nothing and is reported under `onUnmatched`, per call
 *   rather than once, because an agent whose instructions vary with its input can carry a block on
 *   one request and not the next.
 * - Text **past the contract's budget** is refused rather than truncated: half a prompt is not a
 *   smaller version of the prompt.
 *
 * All three decisions come back as `UnappliedEntry` records on `unapplied`, already reported under
 * `onUnmatched`, so an adapter can put them on a span or count them without parsing a message.
 *
 * Added blocks come back with `id: null` and `dynamic: false`: they are new text, nothing addresses
 * them yet, and they are fixed by construction. Each added entry becomes its own block rather than
 * being joined into one, so an adapter can attribute them individually; joining them is a
 * `map(...).join('\n\n')` away for a framework that wants one string.
 */
export function applyInstructions(
  blocks: readonly InstructionBlock[],
  config: AgentConfig,
  options: ApplyInstructionsOptions = {}
): AppliedInstructions {
  const onUnmatched = options.onUnmatched ?? 'warn'
  const overrides = overridesById(config)
  const added = instructionEntries(config)
    .filter((entry) => entry.id === undefined && typeof entry.instructions === 'string')
    .map((entry) => entry.instructions as string)
  if (overrides.size === 0 && added.length === 0) {
    return { blocks: [...blocks], unapplied: [] }
  }

  const unapplied: UnappliedEntry[] = []
  const matched = new Set<string>()
  const result: InstructionBlock[] = []
  const budget = spendBudget(blocks, config, overrides)
  for (const block of blocks) {
    if (block.id === null || !overrides.has(block.id)) {
      result.push(block)
      continue
    }
    // Addressed, and refused for a reason of its own: reported as the dynamic case and not again as
    // a key nothing carries.
    matched.add(block.id)
    if (block.dynamic) {
      unapplied.push({
        reason: 'dynamic-id',
        instructionId: block.id,
        message:
          `Managed agent config addresses instruction block ${repr(block.id)}, which the agent recomputes ` +
          'per request; a managed value would pin or remove that computation, so it is not applied ' +
          'and the block keeps what the code produces.',
      })
      result.push(block)
      continue
    }
    const replacement = overrides.get(block.id) ?? null
    if (replacement === null) {
      continue
    }
    const refusedAt = budget.ids.get(block.id)
    if (refusedAt !== undefined) {
      unapplied.push(oversized(replacement, refusedAt, block.id))
      result.push(block)
      continue
    }
    result.push({ ...block, text: replacement })
  }
  for (const id of overrides.keys()) {
    if (!matched.has(id)) {
      unapplied.push({
        reason: 'unknown-id',
        instructionId: id,
        message:
          `Managed agent config addresses instruction block ${repr(id)}, which this request does not ` +
          'assemble; that entry applies to nothing.',
      })
    }
  }

  const additions: InstructionBlock[] = []
  added.forEach((text, index) => {
    const refusedAt = budget.additions.get(index)
    if (refusedAt !== undefined) {
      unapplied.push(oversized(text, refusedAt))
    } else {
      additions.push({ id: null, text, dynamic: false })
    }
  })
  result.splice(insertionIndex(result), 0, ...additions)
  return { blocks: result, unapplied: reportUnappliedEntries(onUnmatched, unapplied) }
}
