/** Caps on what one `codeMode()` instance lets sandbox code do. Every field is optional. */
export interface CodeModeLimits {
  /**
   * Seconds of wall-clock time per snippet, including time spent waiting on tools and sleeping (default 30).
   * Also Monty's execution-time limit for the snippet's own code.
   */
  timeout?: number
  /** Nested tool calls per snippet (default 100). Calls past the budget fail without reaching the tool. */
  toolCalls?: number
  /** Tool calls running on the host at the same time (default 8). More calls wait for a free slot. */
  concurrentToolCalls?: number
  /**
   * Bytes of JSON result sent to the model per snippet, and separately bytes of printed output (default 64,000).
   * A larger result fails with a message asking for a smaller one; printed output is cut.
   */
  outputBytes?: number
  /** Bytes of source per snippet (default 100,000). */
  codeBytes?: number
  /** Bytes of JSON arguments per nested call (default 1,000,000). */
  toolInputBytes?: number
  /** Bytes of JSON result per nested call (default 10,000,000). */
  toolOutputBytes?: number
  /** Bytes of sandbox heap (default 256 MiB). */
  memory?: number
  /**
   * Host interactions per session, which every tool call, sleep and future resolution uses (default 10,000).
   * Monty's own default of 1,000 would end a long agent run partway through.
   */
  suspensions?: number
}

export type ResolvedLimits = Required<CodeModeLimits>

const DEFAULT_LIMITS: ResolvedLimits = {
  timeout: 30,
  toolCalls: 100,
  concurrentToolCalls: 8,
  outputBytes: 64_000,
  codeBytes: 100_000,
  toolInputBytes: 1_000_000,
  toolOutputBytes: 10_000_000,
  memory: 256 * 1024 * 1024,
  suspensions: 10_000,
}

// These become counts or Monty's unsigned integer limits; a fraction would be truncated or rejected later.
const INTEGER_LIMITS: ReadonlySet<string> = new Set(['toolCalls', 'concurrentToolCalls', 'memory', 'suspensions'])

export function resolveLimits(limits: CodeModeLimits = {}): ResolvedLimits {
  const resolved = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(limits) as [string, unknown][]) {
    if (!(key in DEFAULT_LIMITS)) {
      throw new TypeError(`Unknown code mode limit "${key}". The limits are: ${Object.keys(DEFAULT_LIMITS).join(', ')}.`)
    }
    if (value === undefined) {
      continue
    }
    const valid =
      typeof value === 'number' && value > 0 && Number.isFinite(value) && (!INTEGER_LIMITS.has(key) || Number.isSafeInteger(value))
    if (!valid) {
      const kind = INTEGER_LIMITS.has(key) ? 'a positive integer' : 'a positive number'
      throw new RangeError(`The code mode limit "${key}" must be ${kind}, not ${JSON.stringify(value)}.`)
    }
    resolved[key as keyof ResolvedLimits] = value
  }
  return resolved
}
