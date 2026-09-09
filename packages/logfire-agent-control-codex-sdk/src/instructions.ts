/**
 * Codex's prompt as instruction blocks, and the two config keys those blocks come back down to.
 *
 * Codex assembles the prompt inside the Rust binary and labels every piece of it with a kind
 * (`developer_instructions`, `agents_md`, `permissions`, ...). Those labels are the block ids here,
 * because they are the names Codex itself uses and the only ones a reader of `codex debug
 * prompt-input` would recognize. Exactly two of them are text a caller can set:
 *
 * - `base_instructions` -- Codex's built-in system prompt, replaced wholesale by pointing
 *   `model_instructions_file` at a file.
 * - `developer_instructions` -- an extra developer message injected into the session.
 *
 * Everything else Codex assembles is `dynamic: true`: skills, the permissions preamble, the
 * `AGENTS.md` chain, and the environment context are read off the machine and the repository at
 * session start, so a managed value could only pin one machine's rendering. The core refuses to
 * address a dynamic block, which is why they are listed at all -- an entry naming one gets a warning
 * that says the block is Codex's to compute, rather than "no such block".
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { InstructionBlock } from '@pydantic/logfire-node/agent-control'
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'

/**
 * The `config` object Codex lowers to `--config key=value` overrides.
 *
 * Named off `CodexOptions` rather than imported: the SDK declares the type but does not export it,
 * and deriving it is how this package stays right about it across SDK versions.
 */
export type CodexConfig = NonNullable<CodexOptions['config']>

/** The id of the block that stands for Codex's whole system prompt. */
export const BASE_INSTRUCTIONS_ID = 'base_instructions'
/** The id of the one developer block a caller can set. */
export const DEVELOPER_INSTRUCTIONS_ID = 'developer_instructions'

/**
 * The Codex config key each writable block lowers to.
 *
 * `model_instructions_file` takes a path rather than text, which is why a managed base prompt is
 * written to a file; `experimental_instructions_file` is its deprecated spelling and is deliberately
 * not read here.
 */
export const BASE_INSTRUCTIONS_KEY = 'model_instructions_file'
/** The Codex config key `developer_instructions` blocks lower to. */
export const DEVELOPER_INSTRUCTIONS_KEY = 'developer_instructions'

/**
 * The blocks Codex assembles that nothing here can set, in the order the model sees them.
 *
 * `host_skills` and `permissions` share the developer message with `developer_instructions`;
 * `agents_md` and `environment_context` come later, in a user message. Order matters because the
 * core lands an added block before the first dynamic one -- which puts it at the end of the
 * developer message, next to the block it is a sibling of, and never in front of a cached prefix.
 */
export const CODEX_OWNED_BLOCK_IDS = ['host_skills', 'permissions', 'agents_md', 'environment_context'] as const

/** The text of the two writable blocks, as the caller's own options define them. */
export interface CodeInstructions {
  /** The base prompt the caller replaced Codex's built-in one with, or `''` for the built-in one. */
  base: string
  /** The caller's developer instructions, or `''` when they set none. */
  developer: string
}

/**
 * Read the two writable blocks out of the options the caller would have passed to `new Codex(...)`.
 *
 * The base prompt is a *path* in the caller's options, so its text has to be read off disk to be
 * shown in a baseline. It is resolved against the thread's `workingDirectory`, since that is the cwd
 * the Codex process will resolve it against. A file that cannot be read is not an error: the run is
 * Codex's to fail or not, and all that is lost here is the baseline showing the text.
 */
export function codeInstructions(codex: CodexOptions | undefined, thread: ThreadOptions | undefined): CodeInstructions {
  const config = codex?.config
  const developer = config?.[DEVELOPER_INSTRUCTIONS_KEY]
  const file = config?.[BASE_INSTRUCTIONS_KEY]
  return {
    base: typeof file === 'string' ? readBaseInstructions(file, thread?.workingDirectory) : '',
    developer: typeof developer === 'string' ? developer : '',
  }
}

function readBaseInstructions(file: string, workingDirectory: string | undefined): string {
  const path = resolve(workingDirectory ?? process.cwd(), file)
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.warn(
      // `String(error)` rather than an `instanceof Error` dance: `readFileSync` throws an Error and
      // nothing else, and its `Error: ENOENT: ...` rendering is exactly what says which file it was.
      `Could not read the base instructions at '${path}' (${String(error)}); Codex will still be pointed at ` +
        'it, but the baseline published to Logfire will not show its text.'
    )
    return ''
  }
}

/**
 * The blocks a managed config is applied to, in the order Codex sends them.
 *
 * A writable block with no text is still listed, so a published entry that names it lands instead of
 * being reported as an id nothing carries. The core drops a blank static block from the baseline on
 * its own, so listing it here costs nothing there -- which is deliberate for `base_instructions`: an
 * agent that has not replaced Codex's built-in prompt should not be shown an empty box inviting
 * someone to replace it, but should still honor the id when an expert publishes one.
 *
 * Codex's own blocks are listed with empty text, which is the truth about them: they are assembled
 * inside the binary and the seam is all this adapter can see. The core publishes a dynamic block's
 * id and never its text, and keeps such a block on its id alone, so empty text costs it nothing --
 * the editor still learns that the block exists and that it is not anyone's to change.
 */
export function instructionBlocks(code: CodeInstructions): InstructionBlock[] {
  return [
    { id: BASE_INSTRUCTIONS_ID, text: code.base, dynamic: false },
    { id: DEVELOPER_INSTRUCTIONS_ID, text: code.developer, dynamic: false },
    ...CODEX_OWNED_BLOCK_IDS.map((id) => ({ id, text: '', dynamic: true })),
  ]
}

/** The two writable blocks after a managed config was applied. */
export interface AppliedCodexInstructions {
  /**
   * The developer message text; `''` when there is none to send, `null` when the published config
   * *removed* the block.
   *
   * The two empties are different instructions to give Codex, which is why they are different
   * values. `''` is an agent whose code sets no developer instructions and whose managed config says
   * nothing about them, and it leaves the key alone. `null` is someone deleting the block in
   * Logfire, which has to be sent as an explicit empty override -- see `withInstructions`.
   */
  developer: string | null
  /** The base prompt, or `null` when the published config removed it. */
  base: string | null
}

/**
 * Fold applied blocks back into the two texts Codex takes.
 *
 * Blocks the managed config *added* carry no id, and there is exactly one place in Codex's prompt
 * for text that is not the system prompt, so they are joined onto the developer message in the order
 * the core placed them. Joining rather than dropping is the whole reason an id-less entry is worth
 * supporting here: it is how someone adds a rule to an agent whose code passes no developer
 * instructions at all.
 *
 * A block the core dropped is gone from `blocks` entirely, which is how removal is told apart from a
 * block that is simply empty.
 */
export function foldInstructions(blocks: readonly InstructionBlock[]): AppliedCodexInstructions {
  const developer = blocks
    .filter((block) => block.id === DEVELOPER_INSTRUCTIONS_ID || block.id === null)
    .map((block) => block.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n')
  const removed = !blocks.some((block) => block.id === DEVELOPER_INSTRUCTIONS_ID)
  const base = blocks.find((block) => block.id === BASE_INSTRUCTIONS_ID)
  return {
    developer: developer === '' && removed ? null : developer,
    base: base === undefined ? null : base.text,
  }
}

/**
 * The directory managed base prompts are written to, created on first use.
 *
 * Codex takes the base prompt as a path, and the file has to outlive every `codex exec` the thread
 * spawns, so it lives for the process rather than for the call. One directory per process, mode 0700
 * from `mkdtemp`, one file per distinct text so a config that resolves to the same prompt on every
 * run does not fill it up.
 */
let instructionsDirectory: string | undefined

/**
 * Write a managed base prompt where Codex can read it, and return the path.
 *
 * Written **once** per distinct text, and never rewritten: the path is content-addressed, so a file
 * that exists already holds exactly this text, and a `codex` process started for another thread may
 * be reading that path right now. `writeFileSync` truncates before it writes, and nothing about a
 * synchronous call in this process stops an independent child process from reading the empty file in
 * between -- so the write is exclusive (`wx`), and an already-existing file is the success case
 * rather than a reason to write again.
 */
export function writeBaseInstructions(text: string): string {
  if (instructionsDirectory === undefined) {
    instructionsDirectory = mkdtempSync(join(tmpdir(), 'logfire-agent-control-'))
    process.once('exit', removeBaseInstructions)
  }
  const path = join(instructionsDirectory, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.md`)
  try {
    // Mode 0600 on a file in a shared temp directory: the prompt is the agent's, not the machine's.
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Anything else -- a directory that has been removed, a full or read-only filesystem -- is a
    // prompt Codex will not be given, and pointing it at a path that does not hold this text would
    // be worse than saying so.
    if (!exists(error)) {
      throw error
    }
  }
  return path
}

/** Whether a failed exclusive write failed because the file was already there. */
function exists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * Remove the directory written base prompts live in.
 *
 * Registered on `exit` rather than after each run, because the file has to still be there when Codex
 * reads it and nothing here knows when the last thread is done with it.
 */
export function removeBaseInstructions(): void {
  if (instructionsDirectory === undefined) {
    return
  }
  rmSync(instructionsDirectory, { recursive: true, force: true })
  instructionsDirectory = undefined
}

/**
 * Lower applied instructions onto a copy of the caller's Codex config.
 *
 * The caller's own config is the base, so every key they set that this contract says nothing about
 * -- `sandbox_mode`, `mcp_servers`, `model_verbosity` -- survives untouched.
 *
 * The two keys are lowered differently, because Codex offers a reset for one of them and not the
 * other. Dropping a `-c` override does not restore a default: it exposes whatever the user's
 * `config.toml` says, which this package cannot read. So a *removed* developer block is sent as
 * `developer_instructions=""`, which Codex reads as "no developer instructions" and which beats the
 * config file (verified against `codex debug prompt-input` on codex-cli 0.153.4: the block leaves the
 * developer message entirely). `model_instructions_file` has no such spelling -- an empty value is a
 * path, and Codex fails the run trying to read it -- so removing the base block can only stop *this*
 * package from overriding the prompt. `ManagedCodex` reports that gap under `onUnmatched`.
 */
export function withInstructions(config: CodexConfig | undefined, applied: AppliedCodexInstructions, code: CodeInstructions): CodexConfig {
  let lowered: CodexConfig = { ...config }
  if (applied.developer === null) {
    lowered[DEVELOPER_INSTRUCTIONS_KEY] = ''
  } else if (applied.developer === '') {
    lowered = withoutKey(lowered, DEVELOPER_INSTRUCTIONS_KEY)
  } else {
    lowered[DEVELOPER_INSTRUCTIONS_KEY] = applied.developer
  }

  if (applied.base === null) {
    lowered = withoutKey(lowered, BASE_INSTRUCTIONS_KEY)
  } else if (applied.base !== code.base) {
    lowered[BASE_INSTRUCTIONS_KEY] = writeBaseInstructions(applied.base)
  }
  return lowered
}

/**
 * A copy of a Codex config with one key gone.
 *
 * Rebuilt rather than `delete`d: a Codex config is an index signature, so removing a key from it is
 * a dynamic delete, and building the copy says the same thing without one.
 */
function withoutKey(config: CodexConfig, key: string): CodexConfig {
  return Object.fromEntries(Object.entries(config).filter(([name]) => name !== key))
}
