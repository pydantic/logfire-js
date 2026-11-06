// Helpers shared by the codeMode tests. Not exported from the package.
import type { MontySession, RemoteCheckoutOptions } from '@pydantic/monty'
import type { ToolExecutionOptions } from 'ai'

import type { CodeMode, RunCodeInput, Sandboxes } from './codeMode'

/** Runs `run_code` the way the AI SDK does for one tool call. */
export async function runCode(code: CodeMode, input: RunCodeInput, options: Partial<ToolExecutionOptions<unknown>> = {}): Promise<unknown> {
  const { execute, toModelOutput } = code.tools.run_code
  if (execute === undefined) {
    throw new Error('run_code has no execute function')
  }
  const output = await execute(input, { toolCallId: 'call', messages: [], context: undefined, ...options })
  await toModelOutput?.({ toolCallId: 'call', input, output })
  return output
}

/** Error message of a rejected `run_code` call. */
export async function runCodeError(
  code: CodeMode,
  input: RunCodeInput,
  options: Partial<ToolExecutionOptions<unknown>> = {}
): Promise<string> {
  try {
    await runCode(code, input, options)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('run_code did not fail')
}

/** A pool wrapper that records every checkout, so tests can count sessions and reach the live one. */
export class CountingSandboxes implements Sandboxes {
  readonly sessions: MontySession[] = []
  readonly checkouts: (RemoteCheckoutOptions | undefined)[] = []
  closed = false
  private readonly pool: Sandboxes

  constructor(pool: Sandboxes) {
    this.pool = pool
  }

  async checkout(options?: RemoteCheckoutOptions): Promise<MontySession> {
    this.checkouts.push(options)
    const session = await this.pool.checkout(options)
    this.sessions.push(session)
    return session
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.resolve()
  }
}

/** Resolves on the next turn of the event loop after `ms`, without keeping the process alive. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}
