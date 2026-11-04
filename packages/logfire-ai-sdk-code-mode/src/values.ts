import { pyRepr } from './python'

/** A sandbox value whose JSON would pass the byte budget it was converted under. */
export class ValueTooLargeError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`The value is more than ${String(maxBytes)} bytes of JSON.`)
    this.maxBytes = maxBytes
  }
}

/**
 * Converts a value Monty hands to the host into plain JSON-shaped data. Monty passes Python dicts as Maps at any
 * depth, sets as Sets and big ints as bigints, none of which a tool schema or `JSON.stringify` handles.
 *
 * Monty keeps shared references, so a few dozen sandbox objects (`x = [x, x]`, repeated) can stand for an
 * exponentially large tree. The conversion therefore spends a budget of `maxBytes`, about the JSON size of what it
 * has built so far, and throws `ValueTooLargeError` as soon as it runs out, before the host's memory does.
 */
export function fromSandbox(value: unknown, maxBytes: number): unknown {
  let left = maxBytes
  const spend = (bytes: number): void => {
    left -= bytes
    if (left < 0) {
      throw new ValueTooLargeError(maxBytes)
    }
  }
  const entries = (pairs: Iterable<[unknown, unknown]>): Record<string, unknown> => {
    spend(2)
    const out: Record<string, unknown> = {}
    for (const [key, item] of pairs) {
      const name = String(key)
      spend(byteLength(name) + 4)
      // Defined, not assigned: assigning a `__proto__` key would replace the object's prototype instead of adding data.
      Object.defineProperty(out, name, { value: convert(item), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  const convert = (item: unknown): unknown => {
    if (item instanceof Map) {
      return entries(item as Map<unknown, unknown>)
    }
    if (item instanceof Set || Array.isArray(item)) {
      spend(2)
      const out: unknown[] = []
      for (const element of item as Iterable<unknown>) {
        spend(1)
        out.push(convert(element))
      }
      return out
    }
    if (typeof item === 'bigint') {
      const text = item.toString()
      spend(text.length)
      return Number.isSafeInteger(Number(item)) ? Number(item) : text
    }
    if (item instanceof Uint8Array) {
      spend(item.length + 2)
      return Buffer.from(item).toString('latin1')
    }
    if (typeof item === 'string') {
      spend(byteLength(item) + 2)
      return item
    }
    if (typeof item === 'object' && item !== null) {
      return entries(Object.entries(item))
    }
    spend(typeof item === 'number' ? String(item).length : 5)
    return item
  }
  return convert(value)
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

/**
 * Cuts `text` to about `maxBytes` of UTF-8, keeping its start and end: a traceback's frames come first and the
 * exception last, and either can be the large part.
 */
export function cutMiddle(text: string, maxBytes: number): string {
  const size = byteLength(text)
  if (size <= maxBytes) {
    return text
  }
  const bytes = Buffer.from(text)
  const half = Math.floor(maxBytes / 2)
  const head = bytes
    .subarray(0, half)
    .toString()
    .replace(/\uFFFD$/u, '')
  const tail = bytes
    .subarray(size - half)
    .toString()
    .replace(/^\uFFFD/u, '')
  return `${head}\n... (${String(size - 2 * half)} of ${String(size)} bytes cut) ...\n${tail}`
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

/** A nested call as the started-call summary reports it. Only previews are kept, so a snippet's history stays small. */
export interface StartedCall {
  toolName: string
  inputPreview: string
  status: CallStatus
  outputPreview?: string
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
        ? `returned ${call.outputPreview ?? 'None'}`
        : call.status === 'denied'
          ? 'was denied and did not run'
          : 'did not finish, so it may have applied a partial change'
    const line = `- ${call.toolName}(${call.inputPreview}) ${outcome}`
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
