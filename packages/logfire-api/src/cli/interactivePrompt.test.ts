import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it } from 'vite-plus/test'

import { LogfireCliError } from './errors'
import { createPrompt, NoAnswerAvailableError } from './interactivePrompt'

describe('CLI interactive prompt', () => {
  it('reads a real answer and validates it against the choice list', async () => {
    const { prompt } = makePrompt('2\n')

    await expect(prompt.choice('Pick one', ['1', '2', '3'])).resolves.toBe('2')
  })

  it('reprompts on an answer outside the choice list, then accepts a valid one', async () => {
    const { prompt } = makePrompt('9\n2\n')

    await expect(prompt.choice('Pick one', ['1', '2', '3'])).resolves.toBe('2')
  })

  it('reads two sequential prompts from one piped multi-line write without losing the second answer', async () => {
    // The exact bug this suite exists to catch: a real agent, following the shipped
    // prompt's literal `npx logfire auth`, found that a naive `printf '1\n\n' | ...`
    // answer silently dropped the second line and hung forever -- with BOTH the
    // promise-based and callback-based readline APIs, on a fresh interface per call AND
    // a persistent one. Only reading through the readline interface's async-iterator
    // protocol (what `createPrompt` uses) drains what already arrived in one chunk. A
    // fresh `createInterface` per call, or repeated `question()` calls on a persistent
    // one, both reproduce the hang -- so this test is only meaningful against the real
    // `createPrompt` implementation, not a mock of it.
    await withTimeout(async () => {
      const { prompt } = makePrompt('1\n\n')

      const region = await prompt.choice('Select a region', ['1', '2'])
      expect(region).toBe('1')
      // `waitForEnter` reads the second, empty line from the SAME buffered write.
      await expect(prompt.waitForEnter('Press Enter')).resolves.toBeUndefined()
    })
  })

  it('reads three sequential answers from one piped multi-line write', async () => {
    await withTimeout(async () => {
      const { prompt } = makePrompt('yes\nProject Name\nn\n')

      await expect(prompt.confirm('Create it?')).resolves.toBe(true)
      await expect(prompt.text('Name', 'default')).resolves.toBe('Project Name')
      await expect(prompt.confirm('Again?')).resolves.toBe(false)
    })
  })

  describe('when there is nothing left to read (stdin closed, no TTY)', () => {
    it('choice falls back to its default instead of hanging', async () => {
      await withTimeout(async () => {
        const { prompt } = makePrompt('')
        await expect(prompt.choice('Pick one', ['1', '2'], '1')).resolves.toBe('1')
      })
    })

    it('choice with no default throws NoAnswerAvailableError instead of hanging', async () => {
      await withTimeout(async () => {
        const { prompt } = makePrompt('')
        await expect(prompt.choice('Pick one', ['1', '2'])).rejects.toBeInstanceOf(NoAnswerAvailableError)
      })
    })

    it('NoAnswerAvailableError is a LogfireCliError with a real message, not a bare Error', async () => {
      // `runCli()`'s top-level catch only special-cases `LogfireCliError` -- anything else
      // escapes as a raw, unhandled stack trace, which is exactly the failure mode this
      // whole file exists to remove. A caller with nothing more specific to say than
      // `promptForRegion` has (it names the exact commands to run) can therefore just NOT
      // catch this at all and still get a clean exit code and an actionable message,
      // rather than a blank one.
      await withTimeout(async () => {
        const { prompt } = makePrompt('')
        const error: unknown = await prompt.choice('Pick one', ['1', '2']).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(LogfireCliError)
        expect((error as LogfireCliError).message).toBe(
          'No answer available: not running in a terminal and nothing left to read from stdin.'
        )
        expect((error as LogfireCliError).exitCode).toBe(1)
      })
    })

    it('confirm falls back to its default instead of hanging', async () => {
      await withTimeout(async () => {
        const { prompt: promptYes } = makePrompt('')
        await expect(promptYes.confirm('Continue?', true)).resolves.toBe(true)
        const { prompt: promptNo } = makePrompt('')
        await expect(promptNo.confirm('Continue?', false)).resolves.toBe(false)
      })
    })

    it('text falls back to its default instead of hanging', async () => {
      await withTimeout(async () => {
        const { prompt } = makePrompt('')
        await expect(prompt.text('Name', 'fallback')).resolves.toBe('fallback')
      })
    })

    it('text with no default resolves to an empty string instead of hanging', async () => {
      await withTimeout(async () => {
        const { prompt } = makePrompt('')
        await expect(prompt.text('Name')).resolves.toBe('')
      })
    })

    it('waitForEnter resolves instead of hanging, with no default to fall back to', async () => {
      await withTimeout(async () => {
        const { prompt } = makePrompt('')
        await expect(prompt.waitForEnter('Press Enter')).resolves.toBeUndefined()
      })
    })
  })

  describe('dispose', () => {
    it('is a no-op when no prompt was ever asked', () => {
      const { prompt } = makePrompt('')
      expect(() => prompt.dispose?.()).not.toThrow()
    })

    it('is safe to call more than once', async () => {
      const { prompt } = makePrompt('1\n')
      await prompt.choice('Pick one', ['1', '2'])
      expect(() => {
        prompt.dispose?.()
        prompt.dispose?.()
      }).not.toThrow()
    })

    it('releases a never-ending input stream (the real-TTY case) so the process is not held open', async () => {
      // A piped/redirected input reaches EOF on its own once drained, which is what lets
      // every other test in this file finish without calling `dispose()` at all. A real
      // terminal never does -- there is no EOF, ever -- so `dispose()` closing the
      // interface is the only thing that lets the process exit afterward. Modelled here
      // with a stream that is deliberately never `.end()`-ed; if `dispose()` did not
      // release it, this test would hang and the suite's own timeout would fail it.
      await withTimeout(async () => {
        const input = new PassThrough()
        input.write('1\n')
        const output = new DiscardingWritable()
        const prompt = createPrompt({ input, output })

        await expect(prompt.choice('Pick one', ['1', '2'])).resolves.toBe('1')
        prompt.dispose?.()
        input.destroy()
      })
    })
  })
})

/** A `Prompt` over an input that has already ended -- the answers, if any, are already
 * fully written. Matches how a real agent's tool call pipes a fixed string to a command's
 * stdin, and how a closed/redirected-from-`/dev/null` stdin looks to the process. */
function makePrompt(inputData: string): { prompt: ReturnType<typeof createPrompt> } {
  const input = new PassThrough()
  input.end(inputData)
  return { prompt: createPrompt({ input, output: new DiscardingWritable() }) }
}

class DiscardingWritable extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }
}

/** Every case in this file asserts "resolves", not "resolves within N ms" -- a real hang
 * would otherwise fail as a test-runner timeout with no indication of which promise never
 * settled. Wrapping in a short, generous timeout turns that into an assertion failure
 * that names the case, which is what caught the original bug in the first place. */
async function withTimeout<T>(fn: () => Promise<T>, ms = 2000): Promise<T> {
  // `Promise.race` settles as soon as `fn()` does, but the losing `setTimeout` keeps
  // running regardless -- left uncleared, it holds the event loop open for the rest of
  // `ms` after every fast test and can fire into a promise nothing is awaiting anymore.
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${String(ms)}ms -- a prompt call likely hung`))
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
