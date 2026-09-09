/**
 * Mapping Mastra's system messages onto addressable instruction blocks, and back.
 *
 * Mastra's instructions are a `SystemMessage`: one string, or a list of them, each becoming one
 * system message in the order written. The list is the seam a managed config needs -- but an entry
 * carries no name of its own, so an id is either one the entry declares under
 * `providerOptions.logfire` or one synthesized from its position, and a position is only meaningful
 * while the request's system messages still line up with the ones the code wrote. Most of this file
 * is about establishing that they do.
 */

import type { CoreMessageV4, MessageList } from '@mastra/core/agent/message-list'
import type { InstructionBlock } from '@pydantic/logfire-node/agent-control'

/**
 * A system message as Mastra's buckets hold one.
 *
 * `CoreMessageV4` is the union over every role, so narrowing to the system arm is what lets `content`
 * be read as the string it is declared to be for that role.
 */
export type SystemMessage = Extract<CoreMessageV4, { role: 'system' }>

/** The id of the agent's own instructions when they are a single block, per the contract's reserved name. */
export const AGENT_BLOCK_ID = 'agent'

/**
 * The `providerOptions` namespace an instruction entry declares its own id under.
 *
 * `providerOptions` is `Record<provider, JSONObject>` and every provider reads only its own
 * namespace, so a key under `logfire` reaches this adapter and reaches no provider's wire body --
 * which is what makes it usable as block metadata rather than as a request field. It is the AI SDK's
 * own idiom for attaching something to one system message, where Anthropic's `cacheControl` is
 * declared the same way, and it is the same namespace the AI SDK adapter reads an id from.
 *
 * A declared id is the answer to the one thing a positional id cannot do: survive a reorder. Moving
 * the second entry of a list to the front re-points `agent:0` and `agent:1` at each other's text, so
 * an override published against one of them then rewrites the block it was not written for. An entry
 * carrying `providerOptions: { logfire: { id: 'persona' } }` is addressed as `persona` wherever it
 * sits.
 */
export const PROVIDER_OPTIONS_NAMESPACE = 'logfire'

/**
 * The prefix under which Mastra's own tagged system messages are described.
 *
 * They are named so the Logfire editor can show that the prompt has more in it than the agent's own
 * text -- an MCP server's guidance, a caller's `system` option, recalled memory -- and named apart
 * from `agent:<i>` because they are not the agent's to rewrite: the step hook replaces the *untagged*
 * bucket and leaves every tagged one to the subsystem that owns it.
 */
const TAG_PREFIX = 'tag:'

/**
 * The tagged buckets this adapter describes.
 *
 * A fixed list because `MessageList` can be asked for a tag's messages but not for the tags it holds,
 * so these are the ones Mastra itself writes. A tag another processor invents is invisible here,
 * which costs nothing: it would be unaddressable either way.
 */
const MASTRA_SYSTEM_TAGS = ['mcp-guidance', 'user-provided', 'memory'] as const

/**
 * The agent's instructions as written, when they are addressable at all.
 *
 * `null` is the other outcome, and covers both a callable -- Mastra resolves instructions per request
 * from the request context, so there is no code-side text to address, only a seam -- and a value this
 * adapter cannot read as text, which is treated the same way rather than guessed at.
 */
export interface CodeInstructions {
  /** One entry per block the agent's instructions contribute, in order. */
  blocks: readonly CodeBlock[]
}

/** One block of the agent's own instructions, with the id that addresses it. */
export interface CodeBlock {
  /**
   * What a published override names this block by.
   *
   * A `providerOptions.logfire.id` the entry declares, else the reserved `agent` when the agent wrote
   * a single block and `agent:<i>` when it wrote a list.
   */
  id: string
  /** The text the agent's code gives this block. */
  text: string
}

/** An instruction block that remembers the message it came from, so an untouched one is returned as it was. */
interface SourcedBlock extends InstructionBlock {
  /** The message this block was read from, absent for a block the managed config added. */
  readonly message?: SystemMessage
}

/**
 * Read the agent's configured instructions without resolving them.
 *
 * Deliberately not `agent.getInstructions()`: that *invokes* a callable, which would run the agent's
 * own per-request logic to build a document and could pin whatever one request happened to produce.
 * The raw field says everything needed -- what the blocks are, or that they are computed.
 */
export function readCodeInstructions(value: unknown): CodeInstructions | null {
  // A callable is resolved per request from the request context, so there is no code-side text to
  // address: the request's blocks are seams, and a managed value may add to them but not rewrite them.
  if (typeof value === 'function') {
    return null
  }
  if (Array.isArray(value)) {
    const entries = value as unknown[]
    // Counted before any id is assigned, because an id two entries both declare names neither of
    // them: an override written against it would rewrite both blocks, which is the thing declared
    // ids exist to avoid. Both fall back to their positional ids, so the id addresses nothing and
    // the core reports it, rather than one of the two winning by declaration order.
    const declared = new Map<string, number>()
    for (const entry of entries) {
      const id = declaredId(entry)
      if (id !== undefined) {
        declared.set(id, (declared.get(id) ?? 0) + 1)
      }
    }
    const blocks: CodeBlock[] = []
    for (const [index, entry] of entries.entries()) {
      const text = entryText(entry)
      // One unreadable entry makes the whole value unaddressable rather than shifting every id after
      // it: an id that points at the wrong block is worse than no ids at all.
      if (text === null) {
        return null
      }
      const id = declaredId(entry)
      const unique = id !== undefined && declared.get(id) === 1
      blocks.push({ id: unique ? id : `${AGENT_BLOCK_ID}:${String(index)}`, text })
    }
    return { blocks }
  }
  const text = entryText(value)
  return text === null ? null : { blocks: [{ id: declaredId(value) ?? AGENT_BLOCK_ID, text }] }
}

/** The text of one entry of a Mastra `SystemMessage`, or `null` when it is not one this adapter can read. */
function entryText(entry: unknown): string | null {
  if (typeof entry === 'string') {
    return entry
  }
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const content = (entry as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}

/**
 * The id an entry declares for itself, or `undefined` when it declares none.
 *
 * Read from both spellings of the same field, because Mastra's `SystemMessage` is the union of the AI
 * SDK's v4 and v5 message shapes and they disagree on the name: v5 calls it `providerOptions` and v4
 * calls it `experimental_providerMetadata`. Both are legal in an agent's `instructions`, and an id
 * silently ignored because it was written in the other dialect is worse than no id at all.
 *
 * Anything that is not a non-empty string is no id: a half-filled value should fall back to the
 * positional id rather than make a block addressable under `''` or `123`. Neither is anything in the
 * reserved `tag:` namespace, which names Mastra's own buckets: `toSystemMessages` drops those blocks
 * because they belong to the subsystems that write them, so an entry that claimed one would go
 * missing from the prompt instead of being addressable under it.
 */
function declaredId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const message = entry as { providerOptions?: unknown; experimental_providerMetadata?: unknown }
  const options = message.providerOptions ?? message.experimental_providerMetadata
  if (!isRecord(options)) {
    return undefined
  }
  const namespace = options[PROVIDER_OPTIONS_NAMESPACE]
  if (!isRecord(namespace)) {
    return undefined
  }
  const id = namespace['id']
  return typeof id === 'string' && id !== '' && !id.startsWith(TAG_PREFIX) ? id : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Why a request's blocks cannot be addressed by the ids the code's blocks carry. */
export type Unaddressable =
  /** The caller passed a per-run `instructions:` option, which replaced the agent's blocks outright. */
  | 'replaced'
  /** Two of the agent's own blocks are identical, so `MessageList` kept one and the rest shifted. */
  | 'duplicated'

/**
 * Why this request's system messages do not start with the instructions the code wrote, if they do
 * not.
 *
 * There are two reasons, they are told apart by whether the agent's own text repeats itself, and
 * both are a reason to stand down rather than a mismatch to repair -- an id that addressed a block
 * other than the one it names would rewrite text nobody pointed at. They are distinguished because
 * what to do about them differs: a per-run option is precedence working as it should, and a
 * duplicated block is an agent that cannot be addressed until its blocks say different things.
 *
 * `'duplicated'` wins when both are true, because it is the one with something to fix.
 *
 * The one case this cannot see is a per-run option that *starts* with the agent's own text -- a call
 * passing `['A', 'something for this call']` to an agent whose code says `['A']` reads exactly like
 * that agent plus a block a subsystem added, because Mastra puts both in the same untagged bucket
 * and offers a processor nothing that says which is which. The published value then applies to the
 * block whose text the two agree on. It is the same shape of gap as the one on settings, and it is
 * documented in the README rather than guessed at.
 */
export function unaddressable(systemMessages: readonly SystemMessage[], code: CodeInstructions): Unaddressable | null {
  if (code.blocks.every((block, index) => systemMessages[index]?.content === block.text)) {
    return null
  }
  const texts = new Set(code.blocks.map((block) => block.text))
  return texts.size === code.blocks.length ? 'replaced' : 'duplicated'
}

/**
 * The instruction blocks this request assembles, addressable where the code can be pointed at.
 *
 * Three groups, in the order the model sees them:
 *
 * - the agent's own blocks, under the id each one declares or the position it sits at, static, and
 *   the only ones a managed value can rewrite;
 * - the untagged blocks *after* them, which Mastra's skill and workspace subsystems add per request:
 *   nothing names them, and they are marked dynamic so an added block lands before them rather than
 *   after, keeping the provider's cached prefix where it was;
 * - Mastra's tagged buckets, one block each, marked dynamic for the same reason and because they are
 *   rebuilt per request by whatever owns them.
 *
 * When the agent's instructions are computed per request, every block falls into the second group,
 * except that the first keeps the id `agent` -- so an override that names it is refused as the
 * computed block it is, rather than reported as a block this request does not assemble.
 */
export function requestBlocks(
  systemMessages: readonly SystemMessage[],
  code: CodeInstructions | null,
  messageList: Pick<MessageList, 'getSystemMessages'>
): InstructionBlock[] {
  const blocks: SourcedBlock[] = systemMessages.map((message, index) => {
    const own = code === null ? undefined : code.blocks[index]
    const id = own?.id ?? (index === 0 && code === null ? AGENT_BLOCK_ID : null)
    return { id, text: message.content, dynamic: own === undefined, message }
  })
  for (const tag of MASTRA_SYSTEM_TAGS) {
    const messages = messageList.getSystemMessages(tag) as SystemMessage[]
    // One block per tag, not one per message: the text is never rewritten and never published, so the
    // block exists to say the bucket is there, and one entry says that as well as five do.
    if (messages.length > 0) {
      blocks.push({
        id: `${TAG_PREFIX}${tag}`,
        text: messages.map((message) => message.content).join('\n\n'),
        dynamic: true,
      })
    }
  }
  return blocks
}

/**
 * The blocks that describe the agent as written, for the baseline.
 *
 * Built from the code value rather than from the request, so a run that carried a per-run
 * `instructions:` option -- or that this adapter stood down on for any other reason -- still publishes
 * what the agent says in code. Everything dynamic is carried through from the request, because a seam
 * is only observable there.
 */
export function baselineBlocks(request: readonly InstructionBlock[], code: CodeInstructions | null): InstructionBlock[] {
  if (code === null) {
    return [...request]
  }
  const own = code.blocks.map((block) => ({ id: block.id, text: block.text, dynamic: false }))
  return [...own, ...request.filter((block) => block.dynamic)]
}

/**
 * Turn applied blocks back into the untagged system messages the step hook replaces.
 *
 * Tagged blocks are dropped: they describe buckets this hook does not own, and returning them would
 * copy Mastra's own text into the untagged bucket where it would then be sent twice. A block whose
 * text is unchanged comes back as the very message it was read from, so provider options and anything
 * else riding on it survive a request this adapter did not actually change.
 */
export function toSystemMessages(blocks: readonly InstructionBlock[]): SystemMessage[] {
  const messages: SystemMessage[] = []
  for (const block of blocks) {
    if (block.id?.startsWith(TAG_PREFIX) ?? false) {
      continue
    }
    const source = (block as SourcedBlock).message
    if (source === undefined) {
      messages.push({ role: 'system', content: block.text })
    } else {
      messages.push(source.content === block.text ? source : { ...source, content: block.text })
    }
  }
  return messages
}
