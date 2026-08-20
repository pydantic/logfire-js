import { createInterface } from 'node:readline'

import type { Readable, Writable } from 'node:stream'

import { LogfireCliError } from './errors'

/**
 * Thrown by a prompt when there is nothing left to read. EOF must not authorize a
 * default action; an explicit blank line still selects the displayed default. Extends
 * `LogfireCliError`, not `Error`: `runCli()`'s top-level catch
 * already turns any `LogfireCliError` into a clean message and exit code, so a caller with
 * nothing more specific to say can simply not catch this at all and still avoid the raw,
 * unhandled stack trace this whole file exists to get rid of. A caller that CAN say
 * something more specific -- `promptForRegion` names the exact commands to run instead --
 * catches it and throws its own `LogfireCliError` in its place.
 */
export class NoAnswerAvailableError extends LogfireCliError {
  constructor() {
    super('No answer available: not running in a terminal and nothing left to read from stdin.')
    this.name = 'NoAnswerAvailableError'
  }
}

export interface Prompt {
  choice(message: string, choices: readonly string[], defaultChoice?: string): Promise<string>
  confirm(message: string, defaultYes?: boolean): Promise<boolean>
  text(message: string, defaultValue?: string): Promise<string>
  waitForEnter(message: string): Promise<void>
  /**
   * Release the readline interface, if one was ever created. A no-op if no prompt was
   * ever asked, and safe to call more than once. Exists because a real TTY, unlike a
   * pipe or a redirected file, never reaches EOF on its own -- without this, an
   * interactive terminal session would keep the CLI process alive indefinitely after its
   * last command had nothing left to do, where piped input happened to release it by
   * running out on its own.
   */
  dispose?(): void
}

export interface PromptStreams {
  input: Readable
  output: Writable
}

export function createPrompt({ input, output }: PromptStreams): Prompt {
  // ONE interface for the process's whole lifetime, created lazily so a command that
  // never prompts (`whoami`, `projects list`) never touches stdin at all. Read through
  // the async-iterator protocol, not repeated `question()` calls: verified against a real
  // container that `question()` -- promise-based AND callback-based, on a fresh interface
  // per call or a persistent one -- silently drops whatever answer arrives after the
  // first when several lines land in the same chunk (`printf '1\n2\n' | ...` hangs
  // forever on the second read). The async iterator is the one interface that correctly
  // drains what is already buffered. This is exactly the race the shipped prompt's own
  // literal `npx logfire auth` sequence hits: a real agent had to hand-build a paced named
  // pipe to work around it before this fix existed.
  let rl: ReturnType<typeof createInterface> | undefined
  // `AsyncIterator<string>`'s default `TReturn` is `any` (so is Node's own
  // `NodeJS.AsyncIterator`, which `rl[Symbol.asyncIterator]()` actually returns) --
  // pinned to `undefined` here so the destructure below is typed, not `any`.
  let lines: AsyncIterator<string, undefined> | undefined

  async function ask(question: string): Promise<string | undefined> {
    if (lines === undefined) {
      rl = createInterface({ input, output, terminal: false })
      lines = rl[Symbol.asyncIterator]()
    }
    output.write(question)
    // Deliberately not `input.isTTY`/`process.stdin.isTTY`. That answers "is a terminal
    // attached", which is a different question -- a pipe is not a tty and is perfectly
    // answerable, and piping the answers in is how scripts have always driven this
    // command. Gating on isTTY would turn that into a hard failure. EOF from the
    // iterator (`done: true`) is the only signal that means "nothing is coming".
    const { value, done } = await lines.next()
    return done === true ? undefined : value
  }

  return {
    async choice(message, choices, defaultChoice) {
      const suffix = defaultChoice !== undefined ? ` [${defaultChoice}]` : ''
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- reprompt until a valid choice is entered.
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- prompts are inherently sequential.
        const raw = await ask(`${message}${suffix}: `)
        if (raw === undefined) {
          throw new NoAnswerAvailableError()
        }
        const value = raw.trim() || defaultChoice
        if (value !== undefined && choices.includes(value)) {
          return value
        }
      }
    },
    async confirm(message, defaultYes = true) {
      const suffix = defaultYes ? ' [Y/n]' : ' [N/y]'
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- reprompt until a yes/no answer is entered.
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- prompts are inherently sequential.
        const raw = await ask(`${message}${suffix}`)
        if (raw === undefined) {
          throw new NoAnswerAvailableError()
        }
        const value = raw.trim().toLowerCase()
        if (value === '') {
          return defaultYes
        }
        if (value === 'y' || value === 'yes') {
          return true
        }
        if (value === 'n' || value === 'no') {
          return false
        }
      }
    },
    async text(message, defaultValue) {
      const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : ''
      const raw = await ask(`${message}${suffix}: `)
      if (raw === undefined) {
        throw new NoAnswerAvailableError()
      }
      const trimmed = raw.trim()
      return trimmed === '' ? (defaultValue ?? '') : trimmed
    },
    async waitForEnter(message) {
      // No branch on the result: a real Enter and "nothing left to read" mean the same
      // thing here -- continue. There is no default to fall back to and nothing to
      // validate, only a beat to give a person before a browser window appears, and
      // there is no beat to give when there is no one to press the key.
      await ask(`${message}\n`)
    },
    dispose() {
      rl?.close()
    },
  }
}
