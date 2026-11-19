/** `withCodeMode` builds a `ToolLoopAgent` that gives each `generate()` or `stream()` call its own code mode session. */
import type { MontySession, RemoteCheckoutOptions } from '@pydantic/monty'
import type { GenerateTextResult, OutputInterface, StreamTextResult, ToolLoopAgentSettings, ToolSet } from 'ai'

import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import { ToolLoopAgent } from 'ai'

import type { CodeMode, CodeModeOptions, Sandboxes } from './codeMode'

import { codeMode } from './codeMode'
import { resolveLimits } from './limits'
import { RUN_CODE_TOOL_NAME } from './prompt'

type RunCodeTools = CodeMode['tools']

/** The `codeMode()` options that can differ between requests to one agent. */
export type CallScopedCodeModeOptions<CODE_TOOLS extends ToolSet, RUNTIME_CONTEXT> = Pick<
  CodeModeOptions<CODE_TOOLS, RUNTIME_CONTEXT>,
  'approval' | 'context' | 'runtimeContext'
>

export interface WithCodeModeOptions<CODE_TOOLS extends ToolSet, RUNTIME_CONTEXT, CALL_OPTIONS> extends CodeModeOptions<
  CODE_TOOLS,
  RUNTIME_CONTEXT
> {
  /**
   * Called at the start of each `generate()` or `stream()` call with that call's `options`, before the agent
   * validates them against `callOptionsSchema`. The `context`, `runtimeContext` and `approval` it returns replace
   * the ones given here for that call only, so one agent can give sandbox tools the current user or tenant.
   */
  forCall?: (call: {
    options: CALL_OPTIONS | undefined
  }) => CallScopedCodeModeOptions<CODE_TOOLS, RUNTIME_CONTEXT> | PromiseLike<CallScopedCodeModeOptions<CODE_TOOLS, RUNTIME_CONTEXT>>
}

/**
 * A `ToolLoopAgent` whose model gets `run_code` next to its direct tools. Each `generate()` or `stream()` call gets
 * a fresh code mode session, closed when that call ends, so Python state does not carry from one call to the next.
 */
export class CodeModeAgent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Record<string, unknown> = Record<string, unknown>,
  OUTPUT extends OutputInterface = never,
  CODE_TOOLS extends ToolSet = ToolSet,
> extends ToolLoopAgent<CALL_OPTIONS, TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT> {
  readonly #settings: ToolLoopAgentSettings<CALL_OPTIONS, TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>
  readonly #codeModeOptions: WithCodeModeOptions<CODE_TOOLS, RUNTIME_CONTEXT, CALL_OPTIONS>
  readonly #sandboxes: Sandboxes
  readonly #ownPool: (() => Promise<void>) | undefined

  constructor(
    settings: ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT>,
    codeModeOptions: WithCodeModeOptions<CODE_TOOLS, RUNTIME_CONTEXT, CALL_OPTIONS>
  ) {
    if (settings.tools !== undefined && Object.hasOwn(settings.tools, RUN_CODE_TOOL_NAME)) {
      throw new Error(`The agent's tools include "${RUN_CODE_TOOL_NAME}", the name code mode reserves for its own tool. Rename that tool.`)
    }
    let sandboxes = codeModeOptions.sandboxes
    let ownPool: (() => Promise<void>) | undefined
    if (sandboxes === undefined) {
      const shared = sharedAgentSandboxes(codeModeOptions)
      sandboxes = shared.sandboxes
      ownPool = shared.close
    }
    // createAgentUIStream reads `agent.tools` to restore earlier run_code outputs through run_code's toModelOutput,
    // so the outer agent lists run_code with the real schema and output hook, but no session behind it.
    const { forCall: _forCall, ...templateOptions } = codeModeOptions
    const { run_code: template } = codeMode({ ...templateOptions, sandboxes }).tools
    const placeholder: RunCodeTools = {
      run_code: {
        ...template,
        execute: async () =>
          Promise.reject(new Error('This run_code belongs to the agent definition. Call agent.generate() or agent.stream() to run code.')),
      },
    }
    // ToolLoopAgentSettings is invariant in its tool set, so adding run_code needs a cast.
    const outerSettings = { ...settings, tools: { ...settings.tools, ...placeholder } } as unknown as ToolLoopAgentSettings<
      CALL_OPTIONS,
      TOOLS & RunCodeTools,
      RUNTIME_CONTEXT,
      OUTPUT
    >
    super(outerSettings)
    this.#settings = outerSettings
    this.#codeModeOptions = codeModeOptions
    this.#sandboxes = sandboxes
    this.#ownPool = ownPool
  }

  override async generate(
    options: Parameters<ToolLoopAgent<CALL_OPTIONS, TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>['generate']>[0]
  ): Promise<GenerateTextResult<TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>> {
    const code = await this.#codeMode(options)
    let result: GenerateTextResult<TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>
    try {
      result = await this.#agentFor(code).generate(options)
    } catch (error) {
      await closeQuietly(code)
      throw error
    }
    await closeQuietly(code)
    return result
  }

  override async stream(
    options: Parameters<ToolLoopAgent<CALL_OPTIONS, TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>['stream']>[0]
  ): Promise<StreamTextResult<TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>> {
    const code = await this.#codeMode(options)
    let result: StreamTextResult<TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT>
    try {
      result = await this.#agentFor(code).stream(options)
    } catch (error) {
      await closeQuietly(code)
      throw error
    }
    // Closing failures cannot reach the caller, who already has the result.
    code.closeWhenDone(result).catch(() => undefined)
    return result
  }

  /**
   * Closes the Agent Sandboxes pool this agent created; later calls fail to check out a session. Sessions of
   * running calls close when their calls end. A pool passed as `sandboxes` stays open.
   */
  async close(): Promise<void> {
    await this.#ownPool?.()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  async #codeMode(call: object): Promise<CodeMode> {
    const { forCall, ...options } = this.#codeModeOptions
    const scoped = forCall === undefined ? {} : await forCall({ options: (call as { options?: CALL_OPTIONS }).options })
    return codeMode({ ...options, ...scoped, sandboxes: this.#sandboxes })
  }

  // ToolLoopAgent keeps its settings private, so each call gets a new agent with this call's run_code. The
  // constructor only stores settings, and the caller's prepareCall and callbacks run once, inside this agent.
  #agentFor(code: CodeMode): ToolLoopAgent<CALL_OPTIONS, TOOLS & RunCodeTools, RUNTIME_CONTEXT, OUTPUT> {
    const { prepareCall } = this.#settings
    const settings = { ...this.#settings, tools: { ...this.#settings.tools, ...code.tools } as TOOLS & RunCodeTools }
    if (prepareCall !== undefined) {
      settings.prepareCall = async (args) => {
        const prepared = await prepareCall(args)
        // A prepareCall that returns its own tools must not drop or replace this call's run_code.
        return prepared.tools === undefined ? prepared : { ...prepared, tools: { ...prepared.tools, ...code.tools } }
      }
    }
    return new ToolLoopAgent(settings)
  }
}

/**
 * Builds a `ToolLoopAgent` that gives the model `run_code` next to `settings.tools`, with `codeModeOptions.tools`
 * as typed Python functions inside it. Define it once and call it per request:
 *
 * ```ts
 * const agent = withCodeMode({ model, instructions, tools: { askUser } }, { tools: { getOrders, getCustomer } })
 * const result = await agent.generate({ prompt })
 * ```
 *
 * Each `generate()` or `stream()` call gets its own sandbox session and closes it when the call ends, so Python
 * state lasts for one call. A run that pauses for a tool approval resumes in a new call, with a fresh session.
 * Use `codeModeOptions.forCall` to give each call its own tool context, runtime context or approval.
 * Without `codeModeOptions.sandboxes`, the agent creates one `agentSandboxes()` pool on first use and shares it
 * across calls; close it with `agent.close()` or `await using`.
 */
export function withCodeMode<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Record<string, unknown> = Record<string, unknown>,
  OUTPUT extends OutputInterface = never,
  CODE_TOOLS extends ToolSet = ToolSet,
>(
  settings: ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT>,
  codeModeOptions: WithCodeModeOptions<CODE_TOOLS, RUNTIME_CONTEXT, CALL_OPTIONS>
): CodeModeAgent<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT, CODE_TOOLS> {
  return new CodeModeAgent(settings, codeModeOptions)
}

// Code mode's close() already absorbs session close failures; this keeps any later one from hiding the run's result or error.
async function closeQuietly(code: CodeMode): Promise<void> {
  await code.close().catch(() => undefined)
}

function sharedAgentSandboxes(options: { limits?: CodeModeOptions<ToolSet>['limits'] }): {
  sandboxes: Sandboxes
  close: () => Promise<void>
} {
  if ([undefined, ''].includes(process.env['LOGFIRE_API_KEY'])) {
    throw new Error(
      'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
        'Set the LOGFIRE_API_KEY environment variable, or pass `sandboxes` to withCodeMode().'
    )
  }
  // Same transport slack as codeMode()'s own pool, so a long snippet gets the time-limit message.
  const requestTimeout = resolveLimits(options.limits).timeout / 1000 + 10
  let pool: Promise<Sandboxes> | undefined
  let closed = false
  const sandboxes: Sandboxes = {
    async checkout(checkoutOptions?: RemoteCheckoutOptions): Promise<MontySession> {
      if (closed) {
        throw new Error('This code mode agent is closed, so it cannot check out a sandbox session.')
      }
      pool ??= agentSandboxes({ requestTimeout })
      let created: Sandboxes
      try {
        created = await pool
      } catch (error) {
        pool = undefined
        throw error
      }
      return created.checkout(checkoutOptions)
    },
    // Each call's code mode treats a passed pool as the caller's; the agent closes it in close().
    async close(): Promise<void> {
      await Promise.resolve()
    },
  }
  return {
    sandboxes,
    close: async () => {
      closed = true
      const current = pool
      pool = undefined
      if (current !== undefined) {
        await (await current.catch(() => undefined))?.close()
      }
    },
  }
}
