import type { Context } from '@opentelemetry/api'
import type { MontySession, WebsocketCheckoutOptions } from '@pydantic/monty'
import type { Tool, ToolApprovalConfiguration, ToolExecutionOptions, ToolSet } from 'ai'

import { context as otelContext } from '@opentelemetry/api'
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import { MontyCrashedError, MontyRuntimeError, MontySyntaxError, MontyTypingError, NOT_HANDLED } from '@pydantic/monty'
import { asSchema, jsonSchema, tool } from 'ai'
import * as logfire from 'logfire'
import { setTimeout as sleep } from 'node:timers/promises'

import type { CodeModeLimits, ResolvedLimits } from './limits'
import type { StartedCall } from './values'

import { decideApproval } from './approval'
import { resolveLimits } from './limits'
import { pyIsBuiltin } from './python'
import { CODE_DESCRIPTION, RESTART_DESCRIPTION, RUN_CODE_TOOL_NAME, runCodeDescription } from './prompt'
import { toolStubs } from './stubs'
import { byteLength, describeStartedCalls, forModel, fromSandbox, ValueTooLargeError } from './values'

/** Where code runs: a pool such as `agentSandboxes()`, `MontyWebsocket.create()` or `Monty.create()`. */
export interface Sandboxes {
  checkout(options?: WebsocketCheckoutOptions): Promise<MontySession>
  close(): Promise<void>
}

export interface ToolErrorCall {
  toolName: string
  toolCallId: string
  input: unknown
}

export interface CodeModeOptions<TOOLS extends ToolSet, RUNTIME_CONTEXT = unknown> {
  /** The tools sandbox code can call, as typed async Python functions. Do not also pass them to generateText. */
  tools: TOOLS
  /**
   * Where the code runs. Omitted, code mode creates `agentSandboxes()` on the first `run_code` call and closes it
   * in `close()`. A pool you pass is yours to close. Its `requestTimeout` must be above `limits.timeout`, or a long
   * snippet fails with a transport error instead of the time-limit message.
   */
  sandboxes?: Sandboxes
  /** Context for each tool, keyed by tool name, as generateText's `toolsContext`. */
  context?: { [NAME in keyof TOOLS]?: unknown }
  /**
   * Which nested calls may run, in the shape of generateText's `toolApproval`. Nothing in the sandbox can wait for a
   * person, so a call whose status is `'user-approval'` fails like a denied one.
   */
  approval?: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT>
  /** Passed to `approval` functions; tool execution does not see generateText's `runtimeContext`. */
  runtimeContext?: RUNTIME_CONTEXT
  limits?: CodeModeLimits
  /**
   * Which snippets Monty's type checker sees (default `'first-snippet'`, as pydantic-ai). Monty's checker rejects
   * some valid code, such as a None check on an indexed value, and a model can spend every step trying to satisfy
   * it, so later snippets are not checked once one has passed.
   */
  typeCheck?: 'every-snippet' | 'first-snippet' | 'off'
  /**
   * Seconds without a `run_code` call before the session is released (default 300; `Infinity` disables). It ends
   * sessions of runs that stopped without `close()`, such as a stream cancelled without an abort signal. A later
   * call gets a fresh session, and the model is told that earlier state is gone.
   */
  idleTimeout?: number
  /**
   * Replaces the error the sandbox, the model and the trace see when a tool throws. Return a string or an error to
   * replace it, or `undefined` to keep it. Messages pass through unchanged by default, as in pydantic-ai.
   */
  onToolError?: (error: unknown, call: ToolErrorCall) => Error | string | undefined
}

export interface RunCodeInput {
  code: string
  restart?: boolean | undefined
}

export interface CodeMode extends AsyncDisposable {
  /** `{ run_code }`, to spread into generateText's or streamText's `tools`. */
  readonly tools: { run_code: Tool<RunCodeInput, unknown> }
  /** Ends the session and, if code mode created it, the sandbox pool. Safe to call more than once. */
  close(): Promise<void>
  /** Closes code mode once a streamText result settles, including on error and abort. */
  closeWhenDone(result: { finishReason: PromiseLike<unknown> }): Promise<void>
}

/**
 * Gives an AI SDK agent one `run_code` tool. The model writes Python, the code runs in one sandbox session for the
 * life of this object, and `tools` become typed async functions inside it, so one model step can make many tool
 * calls and keep their results in the sandbox instead of the model's context.
 */
export function codeMode<TOOLS extends ToolSet, RUNTIME_CONTEXT = unknown>(options: CodeModeOptions<TOOLS, RUNTIME_CONTEXT>): CodeMode {
  return new CodeModeRuntime(options)
}

// Monty raises a host error in the sandbox as the Python exception its `name` names.
function pythonError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Keyword arguments arrive as one trailing object without a prototype; anything before it is positional.
function keywordArguments(name: string, args: unknown[], maxBytes: number): Record<string, unknown> {
  const last = args.at(-1)
  const hasKwargs = typeof last === 'object' && last !== null && Object.getPrototypeOf(last) === null
  if (args.length > (hasKwargs ? 1 : 0)) {
    throw pythonError('TypeError', `${name}() does not accept positional arguments; use keyword arguments`)
  }
  if (!hasKwargs) {
    return {}
  }
  try {
    return fromSandbox(last, maxBytes) as Record<string, unknown>
  } catch (error) {
    if (error instanceof ValueTooLargeError) {
      throw pythonError('ValueError', toolInputTooLarge(name, maxBytes))
    }
    throw error
  }
}

function toolInputTooLarge(name: string, maxBytes: number): string {
  return `The arguments to ${name}() are more than ${String(maxBytes)} bytes of JSON, over the limit for one call.`
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The abandoned promise may still reject, and nothing else observes it.
    promise.catch(() => undefined)
    throw signal.reason as Error
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

class Slots {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(size: number) {
    this.free = size
  }

  async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.free > 0) {
      this.free -= 1
      return
    }
    let wake: () => void = () => undefined
    const turn = new Promise<void>((resolve) => {
      wake = resolve
    })
    this.waiting.push(wake)
    try {
      await untilAborted(turn, signal)
    } catch (error) {
      const index = this.waiting.indexOf(wake)
      if (index === -1) {
        // The slot was handed over just as the wait was aborted, so pass it on.
        this.release()
      } else {
        this.waiting.splice(index, 1)
      }
      throw error
    }
  }

  release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.free += 1
    } else {
      next()
    }
  }
}

// A collector that throws poisons the session when it fails during a host call (Monty 1.4.0), so this one only
// stops collecting at the cap.
class PrintCapture {
  private text = ''
  private bytes = 0
  private truncated = false
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  readonly write = (_stream: 'stderr' | 'stdout', fragment: string): void => {
    if (this.truncated) {
      return
    }
    const size = byteLength(fragment)
    if (this.bytes + size <= this.maxBytes) {
      this.text += fragment
      this.bytes += size
      return
    }
    this.text += Buffer.from(fragment)
      .subarray(0, this.maxBytes - this.bytes)
      .toString()
      .replace(/�$/u, '')
    this.truncated = true
  }

  get output(): string {
    return this.truncated ? `${this.text}\n[printed output cut at ${String(this.maxBytes)} bytes]\n` : this.text
  }

  /** pydantic-ai's `PrintCapture.prepend_to`: what printed before the error, then the error. */
  prependTo(message: string): string {
    const printed = this.output.replace(/\n+$/u, '')
    return printed === '' ? message : `[stdout before error]\n${printed}\n[/stdout before error]\n${message}`
  }
}

type StopReason = 'aborted' | 'closed' | 'deadline' | 'finished'

/** One `run_code` call: its nested calls, printed output and deadline. */
class Snippet {
  readonly calls: StartedCall[] = []
  readonly printed: PrintCapture
  deadline = Number.POSITIVE_INFINITY
  callCount = 0
  budgetExhausted = false
  stopped: StopReason | undefined
  private readonly controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  readonly id: string
  readonly limits: ResolvedLimits

  constructor(id: string, limits: ResolvedLimits) {
    this.id = id
    this.limits = limits
    this.printed = new PrintCapture(limits.outputBytes)
  }

  /** Starts the clock once the session is ready, so a slow checkout does not count against the code's time. */
  start(): void {
    this.deadline = Date.now() + this.limits.timeout * 1000
    this.timer = setTimeout(() => {
      this.stop('deadline')
    }, this.limits.timeout * 1000)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  stop(reason: StopReason): void {
    clearTimeout(this.timer)
    if (this.stopped !== undefined) {
      return
    }
    this.stopped = reason
    const message =
      reason === 'deadline'
        ? `the code passed its ${String(this.limits.timeout)}-second time limit`
        : reason === 'aborted'
          ? 'the agent run was aborted'
          : reason === 'closed'
            ? 'code mode was closed'
            : 'the code had already finished'
    this.controller.abort(pythonError('TimeoutError', `Stopped because ${message}.`))
  }

  reason(): StopReason | undefined {
    return this.stopped
  }

  startedCalls(): string {
    return this.calls.length === 0 ? '' : `\n\n${describeStartedCalls(this.calls)}`
  }
}

const SUSPENSION_LIMIT = /^suspension limit [0-9]+ exceeded$/u
const SANDBOX_LIMIT_MARKERS = ['time limit exceeded', 'memory limit exceeded', 'suspension limit ']

/** pydantic-ai's `_is_duration_exhausted`: Monty attaches no frame to the error that stops a snippet at its limit. */
function isDurationExhausted(error: MontyRuntimeError): boolean {
  return error.traceback().length === 0 && error.display('msg').includes('time limit exceeded')
}

interface Failure {
  message: string
  reset: boolean
}

class CodeModeRuntime<TOOLS extends ToolSet, RUNTIME_CONTEXT> implements CodeMode {
  readonly tools: { run_code: Tool<RunCodeInput, unknown> }
  private readonly limits: ResolvedLimits
  private readonly idleTimeout: number
  private readonly pythonNames: Map<string, string>
  private readonly typeCheckStubs: string
  private queue: Promise<unknown> = Promise.resolve()
  private poolPromise: Promise<Sandboxes> | undefined
  private sessionPromise: Promise<MontySession> | undefined
  private passedTypeCheck = false
  private expired = false
  private idleTimer: NodeJS.Timeout | undefined
  private current: Snippet | undefined
  private closing: Promise<void> | undefined
  private readonly options: CodeModeOptions<TOOLS, RUNTIME_CONTEXT>
  private readonly traceContext: Context
  private readonly slots: Slots

  constructor(options: CodeModeOptions<TOOLS, RUNTIME_CONTEXT>) {
    this.options = options
    this.traceContext = otelContext.active()
    const { tools, sandboxes, idleTimeout = 300 } = options
    for (const [name, candidate] of Object.entries(tools)) {
      if (typeof candidate.execute !== 'function') {
        throw new Error(
          `Tool "${name}" has no execute function, so sandbox code cannot call it. Pass it to generateText as a direct tool instead.`
        )
      }
      if ((candidate as { needsApproval?: unknown }).needsApproval !== undefined) {
        throw new Error(`Tool "${name}" sets needsApproval, which code mode cannot enforce. Use the approval option of codeMode() instead.`)
      }
    }
    if (sandboxes === undefined && [undefined, ''].includes(process.env['LOGFIRE_API_KEY'])) {
      throw new Error(
        'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
          'Set the LOGFIRE_API_KEY environment variable, or pass `sandboxes` to codeMode().'
      )
    }
    if (!(idleTimeout > 0)) {
      throw new RangeError(`idleTimeout must be a positive number of seconds or Infinity, not ${String(idleTimeout)}.`)
    }
    this.limits = resolveLimits(options.limits)
    this.slots = new Slots(this.limits.concurrentToolCalls)
    this.idleTimeout = idleTimeout

    const stubs = toolStubs(tools)
    this.typeCheckStubs = stubs.typeCheckStubs
    this.pythonNames = new Map(Object.keys(tools).map((name) => [name, name]))
    for (const [pythonName, toolName] of stubs.toolNames) {
      this.pythonNames.set(toolName, pythonName)
    }
    for (const [toolName, pythonName] of this.pythonNames) {
      if (pyIsBuiltin(pythonName)) {
        throw new Error(
          `Tool "${toolName}" becomes the Python function "${pythonName}", which is a Python builtin, so sandbox code would call the builtin instead. Rename the tool.`
        )
      }
    }

    this.tools = {
      [RUN_CODE_TOOL_NAME]: tool({
        description: runCodeDescription(stubs.typeDefinitions, stubs.functions),
        inputSchema: jsonSchema<RunCodeInput>(
          {
            type: 'object',
            properties: {
              code: { type: 'string', description: CODE_DESCRIPTION },
              restart: { type: 'boolean', description: RESTART_DESCRIPTION },
            },
            required: ['code'],
            additionalProperties: false,
          },
          {
            validate: (value) => {
              const input = value as Partial<RunCodeInput> | null
              const valid =
                typeof input === 'object' &&
                input !== null &&
                typeof input.code === 'string' &&
                (input.restart === undefined || typeof input.restart === 'boolean')
              return valid
                ? { success: true, value: { code: input.code as string, restart: input.restart } }
                : { success: false, error: new TypeError('run_code takes a string `code` and an optional boolean `restart`.') }
            },
          }
        ),
        execute: async (input, toolOptions) => this.enqueue(input, toolOptions),
      }),
    }
  }

  async close(): Promise<void> {
    this.closing ??= this.shutDown()
    return this.closing
  }

  async closeWhenDone(result: { finishReason: PromiseLike<unknown> }): Promise<void> {
    return Promise.resolve(result.finishReason).then(
      async () => this.close(),
      async () => this.close()
    )
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  private async shutDown(): Promise<void> {
    this.clearIdleTimer()
    this.current?.stop('closed')
    await this.queue
    await this.releaseSession()
    const pool = this.options.sandboxes === undefined ? this.poolPromise : undefined
    this.poolPromise = undefined
    if (pool !== undefined) {
      await (await pool).close()
    }
  }

  // A session runs one feed at a time, and a second feed while one waits on a tool call breaks it. The AI SDK runs
  // a step's tool calls in parallel, so run_code calls wait their turn.
  private async enqueue(input: RunCodeInput, toolOptions: ToolExecutionOptions<unknown>): Promise<unknown> {
    const result = this.queue.then(async () => this.run(input, toolOptions))
    this.queue = result.catch(() => undefined)
    return result
  }

  private closedError(): Error {
    return new Error('Code mode is closed, so this code did not run.')
  }

  private stoppedError(snippet: Snippet, ran: boolean): Error {
    const why = snippet.stopped === 'aborted' ? 'The agent run was aborted' : 'Code mode was closed'
    if (!ran) {
      return snippet.stopped === 'aborted' ? new Error(`${why}, so this code did not run.`) : this.closedError()
    }
    return new Error(`${why} while this code ran, so tool calls it had not started were stopped.${snippet.startedCalls()}`)
  }

  private async run({ code, restart }: RunCodeInput, toolOptions: ToolExecutionOptions<unknown>): Promise<unknown> {
    if (this.closing !== undefined) {
      throw this.closedError()
    }
    toolOptions.abortSignal?.throwIfAborted()
    const codeBytes = byteLength(code)
    if (codeBytes > this.limits.codeBytes) {
      throw new Error(
        `The code is ${String(codeBytes)} bytes, over the ${String(this.limits.codeBytes)}-byte limit for one snippet. ` +
          'Send less code per call; variables and functions from earlier calls are still defined.'
      )
    }

    // Registered before anything awaits, so close() and an abort reach a call that is still checking out.
    const snippet = new Snippet(toolOptions.toolCallId, this.limits)
    this.current = snippet
    const onAbort = (): void => {
      snippet.stop('aborted')
    }
    toolOptions.abortSignal?.addEventListener('abort', onAbort, { once: true })
    this.clearIdleTimer()
    const expired = this.expired
    this.expired = false
    try {
      if (restart === true) {
        await this.releaseSession()
      }
      return await this.feed(code, snippet, toolOptions)
    } catch (error) {
      throw expired && error instanceof Error
        ? new Error(
            `${error.message}\n\nThe sandbox session had no run_code call for ${String(this.idleTimeout)} seconds and was replaced, ` +
              'so variables, imports and definitions from earlier calls are gone.'
          )
        : error
    } finally {
      // A call that failed inside asyncio.gather ends the snippet while its siblings still run; stop them, as
      // pydantic-ai cancels its pending tasks.
      snippet.stop('finished')
      toolOptions.abortSignal?.removeEventListener('abort', onAbort)
      this.current = undefined
      this.startIdleTimer()
    }
  }

  private async feed(code: string, snippet: Snippet, toolOptions: ToolExecutionOptions<unknown>): Promise<unknown> {
    let session: MontySession
    try {
      session = await this.session()
    } catch (error) {
      // A failed checkout runs nothing, so it leaves the type-check state alone, as in pydantic-ai.
      throw snippet.stopped === undefined
        ? new Error(this.describeFailure(error, snippet).message, { cause: error })
        : this.stoppedError(snippet, false)
    }
    if (snippet.stopped !== undefined) {
      throw this.stoppedError(snippet, false)
    }

    let value: unknown
    let feedError: unknown
    let fed = false
    snippet.start()
    try {
      const skipTypeCheck = this.options.typeCheck === 'off' || (this.options.typeCheck !== 'every-snippet' && this.passedTypeCheck)
      value = await session.feedRun(code, {
        externalLookup: this.externalLookup(snippet, toolOptions),
        printCallback: snippet.printed.write,
        os: this.osCallback(snippet),
        skipTypeCheck,
      })
      fed = true
      this.passedTypeCheck = true
    } catch (error) {
      feedError = error
      // A snippet that failed at run time still passed type checking.
      this.passedTypeCheck ||= !(error instanceof MontyTypingError || error instanceof MontySyntaxError)
    }

    // Read again: the feed can stop the snippet, which the narrowing above does not see.
    const stopped = snippet.reason()
    if (stopped === 'closed' || stopped === 'aborted') {
      throw this.stoppedError(snippet, true)
    }
    if (stopped === 'deadline') {
      await this.releaseSession()
      const ran =
        feedError instanceof MontyRuntimeError ? `Runtime error:\n${snippet.printed.prependTo(feedError.display('traceback'))}\n\n` : ''
      throw new Error(
        `${ran}The code ran longer than its ${String(this.limits.timeout)}-second time limit, counting time spent waiting on tools, ` +
          'and was stopped, so the session was reset. Re-run any imports, recreate any state you need, and make the code do less work per call.' +
          snippet.startedCalls()
      )
    }
    if (!fed) {
      const failure = this.describeFailure(feedError, snippet)
      if (failure.reset) {
        await this.releaseSession()
      }
      throw new Error(failure.message, { cause: feedError })
    }
    return this.shapeResult(value, snippet)
  }

  /** pydantic-ai's result shapes (`RunCodeExecution.build_tool_return`), checked against `limits.outputBytes`. */
  private shapeResult(value: unknown, snippet: Snippet): unknown {
    const { outputBytes } = this.limits
    const tooLarge = new Error(
      `The result is more than ${String(outputBytes)} bytes of JSON, over the limit for what one snippet returns. ` +
        'The code ran and its variables are still defined, so return a smaller value from them, such as a summary or fewer fields.'
    )
    let result: unknown
    try {
      result = forModel(fromSandbox(value, outputBytes))
    } catch (error) {
      throw error instanceof ValueTooLargeError ? tooLarge : error
    }
    // Printed output is already cut at the same cap, so the cap applies to the result on its own. The conversion's
    // budget only approximates JSON, so the exact size is checked too.
    if (byteLength(JSON.stringify(result ?? null)) > outputBytes) {
      throw tooLarge
    }
    const output = snippet.printed.output
    return output === '' ? (result ?? {}) : result === null || result === undefined ? { output } : { output, result }
  }

  /** The message the model gets for a failed snippet, from pydantic-ai `CodeModeToolset._execute_code`. */
  private describeFailure(error: unknown, snippet: Snippet): Failure {
    const { printed } = snippet
    if (error instanceof MontySyntaxError) {
      return { message: `Syntax error in code:\n${printed.prependTo(error.display('traceback'))}`, reset: false }
    }
    if (error instanceof MontyTypingError) {
      // pydantic-ai resets here to drop the checkout's type-check stubs; this port skips checking per feed instead.
      return { message: `Type error in code:\n${printed.prependTo(error.display())}`, reset: false }
    }
    if (error instanceof MontyRuntimeError) {
      let message = `Runtime error:\n${printed.prependTo(error.display('traceback'))}`
      const summary = error.display('msg')
      if (snippet.budgetExhausted || SANDBOX_LIMIT_MARKERS.some((marker) => summary.includes(marker))) {
        message += snippet.startedCalls()
      }
      const reset = isDurationExhausted(error)
      if (reset) {
        message +=
          '\n\nThe code ran longer than its time limit and was stopped, so the session was reset. Re-run any imports, ' +
          'recreate any state you need, and make the code do less work per call.'
      }
      if (error.exception.typeName === 'RuntimeError' && SUSPENSION_LIMIT.test(summary)) {
        message +=
          "\n\nIf this reports the sandbox session's suspension limit, its cumulative host-interaction budget is exhausted. " +
          'Further tool calls, OS callbacks, name lookups and future resolutions need a fresh session; revising the snippet ' +
          'does not replenish this budget. Pure Python using existing state may still work. Pass `restart: true` to start a ' +
          'fresh session; that discards all REPL variables, imports and definitions. Check the calls already started before ' +
          'continuing, and do not replay completed side effects.'
      }
      return { message, reset }
    }
    if (error instanceof MontyCrashedError) {
      return {
        message: `The code crashed the sandbox worker and the session was reset. Revise the code and try again.${snippet.startedCalls()}`,
        reset: true,
      }
    }
    // A lost connection, a protocol failure or a failed checkout: the session cannot be trusted.
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return {
      message:
        'Code execution failed and the session was reset. Re-run any imports, recreate any state you need, and try again.\n' +
        `${printed.prependTo(text)}${snippet.startedCalls()}`,
      reset: true,
    }
  }

  // Sleeps come to the host (`sleep: 'call_host'`), so the snippet's deadline also bounds them.
  private osCallback(snippet: Snippet): (name: string, args: unknown[]) => Promise<unknown> {
    return async (name, args) => {
      if (name !== 'time.sleep' && name !== 'asyncio.sleep') {
        return NOT_HANDLED
      }
      const seconds = Number(args[0])
      const left = Math.max(0, (snippet.deadline - Date.now()) / 1000)
      if (snippet.stopped !== undefined || seconds > left) {
        throw pythonError(
          'TimeoutError',
          `sleeping ${String(seconds)}s would exceed the ${String(this.limits.timeout)}s this code may run; ${left.toFixed(1)}s left`
        )
      }
      await untilAborted(sleep(seconds * 1000, undefined, { ref: false }), snippet.signal)
      return null
    }
  }

  private externalLookup(
    snippet: Snippet,
    toolOptions: ToolExecutionOptions<unknown>
  ): Record<string, (...args: unknown[]) => Promise<unknown>> {
    return Object.fromEntries(
      Object.keys(this.options.tools).map((toolName) => {
        const pythonName = this.pythonNames.get(toolName) ?? toolName
        return [pythonName, async (...args: unknown[]) => this.callTool(toolName, pythonName, args, snippet, toolOptions)]
      })
    )
  }

  /** One tool call from sandbox code, checked as the AI SDK checks a direct call, and then by code mode's limits. */
  private async callTool(
    toolName: string,
    pythonName: string,
    args: unknown[],
    snippet: Snippet,
    toolOptions: ToolExecutionOptions<unknown>
  ): Promise<unknown> {
    const { limits } = this
    const target = this.options.tools[toolName] as TOOLS[string]
    const kwargs = keywordArguments(pythonName, args, limits.toolInputBytes)
    if (snippet.stopped !== undefined) {
      throw snippet.signal.reason as Error
    }
    // Reserved before anything awaits, so calls started together by asyncio.gather cannot all pass the check.
    if (snippet.callCount >= limits.toolCalls) {
      snippet.budgetExhausted = true
      throw pythonError(
        'RuntimeError',
        `Code mode allows ${String(limits.toolCalls)} nested tool calls per \`run_code\` call and this snippet asked for more. ` +
          'Call fewer tools, for example by filtering the inputs first, or split the work across several `run_code` calls.'
      )
    }
    snippet.callCount += 1
    const toolCallId = `${snippet.id}__${String(snippet.callCount)}`

    if (byteLength(JSON.stringify(kwargs)) > limits.toolInputBytes) {
      throw pythonError('ValueError', toolInputTooLarge(pythonName, limits.toolInputBytes))
    }
    const validated = await untilAborted(Promise.resolve(asSchema(target.inputSchema).validate?.(kwargs)), snippet.signal)
    if (validated !== undefined && !validated.success) {
      throw pythonError('ValueError', `Invalid arguments for ${pythonName}(): ${errorMessage(validated.error)}`)
    }
    const input: unknown = validated === undefined ? kwargs : (validated.value as unknown)
    const contexts = this.options.context
    // Own properties only, as the AI SDK reads them: a tool named `toString` must not get Object.prototype's.
    let toolContext: unknown = contexts !== undefined && Object.hasOwn(contexts, toolName) ? contexts[toolName] : undefined
    if (target.contextSchema !== undefined) {
      const context = await untilAborted(Promise.resolve(asSchema(target.contextSchema).validate?.(toolContext)), snippet.signal)
      if (context !== undefined && !context.success) {
        throw pythonError('ValueError', `Invalid context for tool "${toolName}": ${errorMessage(context.error)}`)
      }
      toolContext = context === undefined ? toolContext : context.value
    }

    const record: StartedCall = { toolName, input, status: 'running' }
    const decision = await untilAborted(
      decideApproval(
        this.options.approval,
        {
          tools: this.options.tools,
          toolsContext: this.options.context ?? {},
          runtimeContext: this.options.runtimeContext as RUNTIME_CONTEXT,
        },
        { toolName, toolCallId, input, messages: toolOptions.messages, toolContext }
      ),
      snippet.signal
    )
    if (!decision.approved) {
      record.status = 'denied'
      snippet.calls.push(record)
      const reason = decision.reason === undefined ? '' : ` ${decision.reason}`
      throw pythonError(
        'RuntimeError',
        decision.needsUser
          ? `Tool '${toolName}' needs a person to approve it, and code mode cannot ask for approval from inside the sandbox.${reason}`
          : `Tool '${toolName}' call denied:${reason === '' ? ' denied by the approval policy' : reason}`
      )
    }

    await this.slots.acquire(snippet.signal)
    // A tool that ignores its abort signal keeps running after the sandbox stops waiting for it, so its slot is
    // held until the tool itself settles, and the cap covers every run_code call of this instance.
    let released = false
    const releaseOnce = (): void => {
      if (!released) {
        released = true
        this.slots.release()
      }
    }
    const call: { running?: Promise<unknown> } = {}
    snippet.calls.push(record)
    try {
      return await logfire.span(
        'run_code called {tool_name}',
        { tool_name: toolName, tool_call_id: toolCallId, arguments: input },
        {},
        async () => {
          let output: unknown
          try {
            // Approval, validation or a free slot can take long enough for the snippet to stop meanwhile.
            snippet.signal.throwIfAborted()
            const running = this.execute(target, input, { ...toolOptions, toolCallId, context: toolContext, abortSignal: snippet.signal })
            call.running = running
            running.then(releaseOnce, releaseOnce)
            output = await untilAborted(running, snippet.signal)
          } catch (error) {
            record.status = 'failed'
            // Inside the span callback, so the span records the replacement and never the original message.
            throw snippet.stopped === undefined ? this.replaceToolError(error, { toolName, toolCallId, input }) : error
          }
          const json = JSON.stringify(output ?? null)
          record.status = 'returned'
          record.output = JSON.parse(json) as unknown
          const outputBytes = byteLength(json)
          if (outputBytes > limits.toolOutputBytes) {
            throw pythonError(
              'ValueError',
              `${pythonName}() returned ${String(outputBytes)} bytes of JSON, over the ${String(limits.toolOutputBytes)}-byte limit for one call. ` +
                'The call ran, so do not repeat it to get the same result.'
            )
          }
          return record.output
        }
      )
    } finally {
      if (call.running === undefined) {
        releaseOnce()
      }
    }
  }

  private async execute(target: TOOLS[string], input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown> {
    const execute = target.execute as (input: unknown, options: ToolExecutionOptions<unknown>) => unknown
    const result = execute(input, options)
    if (isAsyncIterable(result)) {
      // A streaming tool's last value is its result, as for a direct call.
      let last: unknown
      for await (const value of result) {
        last = value
      }
      return last
    }
    return await result
  }

  private replaceToolError(error: unknown, call: ToolErrorCall): Error {
    const replacement = this.options.onToolError?.(error, call)
    if (replacement instanceof Error) {
      return replacement
    }
    if (typeof replacement === 'string') {
      return new Error(replacement)
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  private async pool(): Promise<Sandboxes> {
    const { sandboxes } = this.options
    // The transport's per-turn deadline must outlast the snippet's own limit, so the model gets the time-limit
    // message rather than a dropped connection (pydantic-ai `_REMOTE_TURN_SLACK_SECS`).
    this.poolPromise ??= sandboxes === undefined ? agentSandboxes({ requestTimeout: this.limits.timeout + 10 }) : Promise.resolve(sandboxes)
    try {
      return await this.poolPromise
    } catch (error) {
      this.poolPromise = undefined
      throw error
    }
  }

  private async session(): Promise<MontySession> {
    this.sessionPromise ??= this.checkout()
    try {
      return await this.sessionPromise
    } catch (error) {
      this.sessionPromise = undefined
      throw error
    }
  }

  private async checkout(): Promise<MontySession> {
    const typeCheck = this.options.typeCheck !== 'off'
    // The checkout sends the active trace context, so the session's spans join the agent run's trace.
    return otelContext.with(this.traceContext, async () =>
      (await this.pool()).checkout({
        // Without it, ASB keeps a closed session for 7 days, with any data the tools returned.
        ephemeral: true,
        scriptName: 'run_code.py',
        typeCheck,
        ...(typeCheck ? { typeCheckStubs: this.typeCheckStubs } : {}),
        limits: {
          maxFeedDurationSecs: this.limits.timeout,
          maxMemory: this.limits.memory,
          maxSuspensions: this.limits.suspensions,
        },
        // pydantic-ai's policy: no clock or randomness, and sleeps on the host.
        osPolicy: { datetime: 'call_host', sleep: 'call_host', randomStart: 'call_host' },
      })
    )
  }

  private async releaseSession(): Promise<void> {
    const session = this.sessionPromise
    this.sessionPromise = undefined
    this.passedTypeCheck = false
    if (session === undefined) {
      return
    }
    try {
      await (await session).close()
    } catch {
      // A session that crashed or never opened has nothing left to release.
    }
  }

  private startIdleTimer(): void {
    if (this.closing !== undefined || this.sessionPromise === undefined || !Number.isFinite(this.idleTimeout)) {
      return
    }
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined
        if (this.current === undefined && this.closing === undefined) {
          this.expired = true
          this.releaseSession().catch(() => undefined)
        }
      },
      Math.min(this.idleTimeout * 1000, 2 ** 31 - 1)
    )
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}
