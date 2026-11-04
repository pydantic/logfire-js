import { pyRepr } from './python'

/**
 * Converts a value Monty hands to the host into plain JSON-shaped data. Monty passes Python dicts as Maps at any
 * depth, sets as Sets and big ints as bigints, none of which a tool schema or `JSON.stringify` handles.
 */
export function fromSandbox(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([key, item]: [unknown, unknown]) => [String(key), fromSandbox(item)]))
  }
  if (value instanceof Set || Array.isArray(value)) {
    return Array.from(value as Iterable<unknown>, fromSandbox)
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('latin1')
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromSandbox(item)]))
  }
  return value
}

/**
 * Converts a snippet's result into what the model receives. The JSON forms of `inf` and `nan` are `null`, which
 * would hide the value, so they use their Python `repr`, as pydantic-ai's `_model_safe_result` does.
 */
export function forModel(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  }
  if (Array.isArray(value)) {
    return value.map(forModel)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, forModel(item)]))
  }
  return value
}

/** UTF-8 size of a value's JSON, or of a string itself. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

// Bounds from pydantic-ai `_toolset.py`. The summary identifies calls; it does not redeliver their payloads.
const PREVIEW_CHARS = 120
const PREVIEW_ITEMS = 5
const SUMMARY_MAX_CHARS = 2000

function elided(count: number, shown: number, unit: string): string {
  return count > shown ? ` ... (${String(count)} ${unit} total)` : ''
}

/** pydantic-ai's `_preview`: a value for an error message, cut before it is rendered. */
export function preview(value: unknown, nested = false): string {
  if (typeof value === 'string') {
    return pyRepr(value.slice(0, PREVIEW_CHARS)) + elided(value.length, PREVIEW_CHARS, 'chars')
  }
  if (Array.isArray(value)) {
    if (nested) {
      return `[${String(value.length)} items]`
    }
    const shown = value.slice(0, PREVIEW_ITEMS).map((item) => preview(item, true))
    return `[${shown.join(', ')}]` + elided(value.length, PREVIEW_ITEMS, 'items')
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (nested) {
      return `{${String(entries.length)} items}`
    }
    const shown = entries.slice(0, PREVIEW_ITEMS).map(([key, item]) => `${preview(key, true)}: ${preview(item, true)}`)
    return `{${shown.join(', ')}}` + elided(entries.length, PREVIEW_ITEMS, 'items')
  }
  return value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number' ? pyRepr(value) : '<object>'
}

export type CallStatus = 'denied' | 'failed' | 'returned' | 'running'

export interface StartedCall {
  toolName: string
  input: unknown
  status: CallStatus
  output?: unknown
}

/**
 * pydantic-ai's `_describe_started_calls`. A call that failed is reported like one that never finished, because
 * a tool can commit a side effect before it throws.
 */
export function describeStartedCalls(calls: readonly StartedCall[]): string {
  const lines: string[] = []
  let used = 0
  for (const call of calls) {
    const outcome =
      call.status === 'returned'
        ? `returned ${preview(call.output)}`
        : call.status === 'denied'
          ? 'was denied and did not run'
          : 'did not finish, so it may have applied a partial change'
    const line = `- ${call.toolName}(${preview(call.input)}) ${outcome}`
    if (used + line.length > SUMMARY_MAX_CHARS) {
      lines.push(`- ... and ${String(calls.length - lines.length)} more not shown`)
      break
    }
    lines.push(line)
    used += line.length
  }
  const count = String(calls.length)
  return (
    `${count} nested tool calls started before execution stopped:\n` +
    lines.join('\n') +
    `\nAccount for all ${count} before retrying; repeating a call repeats whatever it already did.`
  )
}
