/**
 * The AI SDK's system messages, as instruction blocks a managed config can address.
 *
 * The AI SDK has a real notion of several instruction blocks -- `instructions` accepts an array of
 * `SystemModelMessage`s, each of which becomes its own `{role: 'system'}` message on the wire, in
 * source order, with its `providerOptions` intact. What it does not have is a name for any of them,
 * so this module synthesizes one.
 *
 * # Two questions about a block, not one
 *
 * A block gets classified twice here, and the two answers are not the same. *Is it recomputed per
 * request* decides whether a published value may address it, and is a judgement about this request.
 * *Is its text provably the agent's own* decides whether that text may be published into the shared
 * baseline, and admits no judgement at all: a rendering this adapter merely observed belongs to
 * whichever tenant, user, or retrieved document the run carried, and a variable every member of a
 * Logfire project can read is the last place it should end up. So an unproven block is published as a
 * seam -- its id, and that it exists -- while staying perfectly addressable at runtime.
 */

import type { InstructionBlock } from '@pydantic/logfire-node/agent-control'
import type { LanguageModelV4Message, LanguageModelV4Prompt, SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { Instructions } from 'ai'

/**
 * The `providerOptions` namespace a user declares a block's id under.
 *
 * `providerOptions` is `Record<provider, JSONObject>` and each provider parses only its own
 * namespace, so a key under `logfire` reaches this adapter and reaches no provider's wire body --
 * which is what makes it usable as block metadata rather than as a request field. It is also the AI
 * SDK's own idiom for attaching something to one system message: Anthropic's `cacheControl` is
 * declared the same way.
 */
export const PROVIDER_OPTIONS_NAMESPACE = 'logfire'

/** A system message in one request's prompt, and the id that addresses it. */
export interface SystemSlot {
  /** Where the message sits in the prompt. */
  index: number
  /** What addresses it: a declared `providerOptions.logfire.id`, else `system:<n>`. */
  id: string
  /** The message's text. */
  text: string
  /** Whether this text differs from what the agent's code declares under this id. */
  dynamic: boolean
  /** Whether this text is provably the agent's own, and so publishable; see the module comment. */
  codeSide: boolean
}

/** A system message is `{role: 'system', content: string}` plus the shared `providerOptions`. */
export type SystemMessage = Extract<LanguageModelV4Message, { role: 'system' }>

/**
 * `Instructions` in its one canonical shape: the list of system messages it stands for.
 *
 * The AI SDK accepts a bare string, one message, or a list, and all three become the same thing on
 * the wire -- so everything downstream of here only has to know about the list.
 */
export function instructionMessages(instructions: Instructions | undefined): SystemMessage[] {
  if (instructions === undefined) {
    return []
  }
  if (typeof instructions === 'string') {
    return [{ role: 'system', content: instructions }]
  }
  return Array.isArray(instructions) ? [...instructions] : [instructions]
}

/**
 * The id declared on a message, or `undefined` when it declares none.
 *
 * Anything that is not a non-empty string is treated as no id at all: a half-filled value should
 * fall back to the positional id rather than making a block addressable under `''` or `123`.
 */
function declaredId(providerOptions: SharedV4ProviderOptions | undefined): string | undefined {
  const id = providerOptions?.[PROVIDER_OPTIONS_NAMESPACE]?.['id']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The id for the `n`-th system message of a prompt.
 *
 * Positional, because the AI SDK gives a system message no name of its own. That makes an id stable
 * for as long as the agent's own instructions are, and *not* stable across a `prepareStep` that
 * injects a system message ahead of them -- which is exactly why a user who wants a durable id
 * declares one under `providerOptions.logfire`.
 */
function positionalId(n: number): string {
  return `system:${String(n)}`
}

/** The system messages of a prompt, in order, with their ids and their positions. */
export function systemSlots(prompt: readonly LanguageModelV4Message[], code: CodeInstructions): SystemSlot[] {
  const slots: SystemSlot[] = []
  for (const [index, message] of prompt.entries()) {
    if (message.role !== 'system') {
      continue
    }
    const id = declaredId(message.providerOptions) ?? positionalId(slots.length)
    slots.push({
      index,
      id,
      text: message.content,
      dynamic: code.isDynamic(id, message.content),
      codeSide: code.isCodeSide(id, message.content),
    })
  }
  return slots
}

/** A slot as the core models it: what to address, what it says, and whether it is recomputed. */
export function blockOf(slot: SystemSlot): InstructionBlock {
  return { id: slot.id, text: slot.text, dynamic: slot.dynamic }
}

/**
 * A slot as the baseline may describe it, which is less than the core would otherwise publish.
 *
 * A block whose text this adapter cannot prove came from the agent's own `instructions` is handed
 * over as a dynamic block, so `buildBaseline` publishes its seam and drops its text. That is not a
 * claim that the framework recomputes it -- `dynamic` is the core's only way to say "there is a block
 * here and its words are not mine to publish", and the alternative is uploading one request's
 * rendering into a shared project variable, where no later request can take it back.
 */
export function baselineBlockOf(slot: SystemSlot): InstructionBlock {
  return slot.codeSide ? blockOf(slot) : { id: slot.id, text: '', dynamic: true }
}

/**
 * What the agent declares in code, against which a request's system messages are classified.
 *
 * The AI SDK's `instructions` are always static data -- never a callable -- so anything else that
 * turns up as a system message came from somewhere this adapter cannot see: a `prepareCall` or
 * `prepareStep` hook, or a system message carried in the run's `messages`. Those are recomputed per
 * request by definition, and the core refuses to address a block marked `dynamic`, so classifying
 * them correctly is what keeps a managed value from pinning one rendering of one run's text.
 *
 * Content equality is the only signal there is; the SDK carries no flag.
 */
export class CodeInstructions {
  readonly #texts: Map<string, string> | undefined
  /** Whether `#texts` is the agent's own declaration rather than one request this adapter watched. */
  readonly #declared: boolean

  private constructor(texts: Map<string, string> | undefined, declared: boolean) {
    this.#texts = texts
    this.#declared = declared
  }

  /**
   * The blocks an agent declares statically, from `ToolLoopAgentSettings.instructions`.
   *
   * Available before the agent has ever run, which is what lets even the first request tell an
   * injected system message from a declared one -- and the only thing that ever makes a block's text
   * publishable, since it is the only text this adapter can point at a line of code for.
   */
  static declared(instructions: readonly SystemMessage[]): CodeInstructions {
    const texts = new Map<string, string>()
    for (const [n, message] of instructions.entries()) {
      texts.set(declaredId(message.providerOptions) ?? positionalId(n), message.content)
    }
    return new CodeInstructions(texts, true)
  }

  /**
   * Nothing declared: a bare `wrapLanguageModel` install, or an agent whose hooks supply the prompt.
   *
   * `learn` fills it in from the first request, so a block that turns out to change between requests
   * is refused from the second one on -- and on the first, where there is nothing to compare against,
   * treating a block as addressable is what makes a fresh install work rather than refusing every
   * override until the agent has run twice.
   *
   * What learning never does is make a block *publishable*. A text seen once is a text seen once; it
   * may be the agent's prompt or it may be one tenant's, and the baseline is read by everyone.
   */
  static unknown(): CodeInstructions {
    return new CodeInstructions(undefined, false)
  }

  /** Take this request's system messages as the code-side text, if nothing is known yet. */
  learn(slots: readonly SystemSlot[]): CodeInstructions {
    if (this.#texts !== undefined) {
      return this
    }
    return new CodeInstructions(new Map(slots.map((slot) => [slot.id, slot.text])), false)
  }

  isDynamic(id: string, text: string): boolean {
    return this.#texts !== undefined && this.#texts.get(id) !== text
  }

  isCodeSide(id: string, text: string): boolean {
    return this.#declared && this.#texts?.get(id) === text
  }
}

/**
 * Write applied blocks back into the prompt they came from.
 *
 * Every surviving block goes back into *its own* message's position, rather than into the next free
 * system slot: a prompt may carry a system message after a user one -- `messages` can contain one,
 * and `allowSystemInMessages` lets it through -- and consuming the slots in order would slide that
 * later block up past the conversation when an earlier one was removed. A block a managed value
 * dropped therefore leaves a gap and moves nothing, and blocks the core added land where the core put
 * them: immediately before the block that followed them, which is the end of the static group, so a
 * managed value never moves a provider's prompt-cache boundary.
 *
 * A prompt with no system message at all gets the added blocks at the front, since that is the only
 * place a system message can go.
 */
export function writeSystemMessages(
  prompt: LanguageModelV4Prompt,
  slots: readonly SystemSlot[],
  blocks: readonly InstructionBlock[]
): LanguageModelV4Prompt {
  const byId = new Map(slots.map((slot) => [slot.id, slot]))
  // Walked once to sort the returned blocks into "text for the slot at this index" and "added text to
  // emit just before that slot". An added block comes back with `id: null`; everything else is one of
  // the messages we handed in.
  const survivors = new Map<number, string>()
  const additions = new Map<number, string[]>()
  let pending: string[] = []
  for (const block of blocks) {
    const slot = block.id === null ? undefined : byId.get(block.id)
    if (slot === undefined) {
      pending.push(block.text)
      continue
    }
    if (pending.length > 0) {
      additions.set(slot.index, pending)
      pending = []
    }
    survivors.set(slot.index, block.text)
  }

  const lastSlot = slots.at(-1)
  if (lastSlot === undefined) {
    return [...pending.map(systemMessage), ...prompt]
  }

  const slotIndices = new Set(slots.map((slot) => slot.index))
  const result: LanguageModelV4Prompt = []
  for (const [index, message] of prompt.entries()) {
    if (!slotIndices.has(index)) {
      result.push(message)
      continue
    }
    for (const text of additions.get(index) ?? []) {
      result.push(systemMessage(text))
    }
    const surviving = survivors.get(index)
    // The message at a slot's index is that slot's system message, so spreading it is what carries a
    // replaced block's own `providerOptions` -- its declared id, a cache breakpoint -- across.
    if (surviving !== undefined) {
      result.push({ ...(message as SystemMessage), content: surviving })
    }
    // Anything the core added after the last surviving block belongs at the end of the system run.
    if (index === lastSlot.index) {
      result.push(...pending.map(systemMessage))
    }
  }
  return result
}

function systemMessage(content: string): SystemMessage {
  return { role: 'system', content }
}
