/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

// This file was generated by ChatGPT by asking it to port logfire/_internal/scrubbing.py to TypeScript.

export type JsonPath = (number | string)[]
export interface ScrubbedNote {
  matchedSubstring: string
  path: JsonPath
}

export interface ScrubMatch {
  path: JsonPath
  patternMatch: RegExpMatchArray
  value: any
}

export type ScrubCallback = (match: ScrubMatch) => any

/**
 * Interface for attribute scrubbers that can process values and potentially
 * redact sensitive information.
 */
export interface AttributeScrubber {
  /**
   * Scrubs a value recursively.
   * @param path The JSON path to this value.
   * @param value The value to scrub.
   * @returns A tuple: [scrubbedValue, scrubbedNotes]
   */
  scrubValue(path: JsonPath, value: unknown): readonly [any, ScrubbedNote[]]
}

const DEFAULT_PATTERNS = [
  'password',
  'passwd',
  'mysql_pwd',
  'secret',
  'auth(?!ors?\\b)',
  'credential',
  'private[._ -]?key',
  'api[._ -]?key',
  'session',
  'cookie',
  'csrf',
  'xsrf',
  'jwt',
  'ssn',
  'social[._ -]?security',
  'credit[._ -]?card',
]

// Should be kept roughly in sync with `logfire._internal.scrubbing.BaseScrubber.SAFE_KEYS`
const SAFE_KEYS = new Set([
  'code.filepath',
  'code.function',
  'code.lineno',
  'db.plan',
  'db.statement',
  'exception.stacktrace',
  'exception.type',
  'http.method',
  'http.route',
  'http.scheme',
  'http.status_code',
  'http.target',
  'http.url',
  'logfire.json_schema',
  'logfire.level_name',
  'logfire.level_num',
  'logfire.logger_name',
  'logfire.msg',
  'logfire.msg_template',
  'logfire.null_args',
  'logfire.package_versions',
  'logfire.pending_parent_id',
  'logfire.sample_rate',
  'logfire.scrubbed',
  'logfire.span_type',
  'logfire.tags',
  'schema.url',
  'url.full',
  'url.path',
  'url.query',
])

export class LogfireAttributeScrubber implements AttributeScrubber {
  private _callback?: ScrubCallback
  private _pattern: RegExp

  constructor(patterns?: string[], callback?: ScrubCallback) {
    const allPatterns = [...DEFAULT_PATTERNS, ...(patterns ?? [])]
    this._pattern = new RegExp(allPatterns.join('|'), 'i')
    this._callback = callback
  }

  /**
   * Scrubs a value recursively using default patterns.
   * @param path The JSON path to this value.
   * @param value The value to scrub.
   * @returns A tuple: [scrubbedValue, scrubbedNotes]
   */
  scrubValue<T>(path: JsonPath, value: T) {
    const scrubbedNotes: ScrubbedNote[] = []
    const scrubbedValue = this.scrub(path, value, scrubbedNotes)
    return [scrubbedValue, scrubbedNotes] as const
  }

  private redact(path: JsonPath, value: any, match: RegExpMatchArray, notes: ScrubbedNote[]): any {
    // If callback is provided and returns a non-null value, use that
    if (this._callback) {
      const callbackResult = this._callback({ path, patternMatch: match, value })
      if (callbackResult !== null && callbackResult !== undefined) {
        return callbackResult
      }
    }

    const matchedSubstring = match[0]
    notes.push({ matchedSubstring, path })
    return `[Scrubbed due to '${matchedSubstring}']`
  }

  private scrub<T>(path: JsonPath, value: T, notes: ScrubbedNote[]): Record<string, any> | string | T | T[] {
    if (typeof value === 'string') {
      // Check if the string matches the pattern
      const match = value.match(this._pattern)
      if (match) {
        // If the entire string is just the matched pattern, consider it safe.
        // e.g., if value == 'password', just leave it.
        if (!(match.index === 0 && match[0].length === value.length)) {
          // Try to parse as JSON
          try {
            const parsed = JSON.parse(value)
            // If parsed, scrub the parsed object
            const newVal = this.scrub(path, parsed, notes)
            return JSON.stringify(newVal)
          } catch {
            // Not JSON, redact directly
            return this.redact(path, value, match, notes)
          }
        }
      }
      return value
    } else if (Array.isArray(value)) {
      return value.map((v, i) => this.scrub([...path, i], v, notes))
    } else if (value && typeof value === 'object') {
      // Object
      const result: Record<string, any> = {}
      for (const [k, v] of Object.entries(value)) {
        if (SAFE_KEYS.has(k) || ['boolean', 'number', 'undefined'].includes(typeof v) || v === null) {
          // Safe key or a primitive value, no scrubbing of the key itself.
          // (In the Python SDK we still scrub primitive values to be extra careful)
          result[k] = v
        } else {
          // Check key against the pattern
          const keyMatch = k.match(this._pattern)
          if (keyMatch) {
            // Key contains sensitive substring
            const redacted = this.redact([...path, k], v, keyMatch, notes)
            // If v is an object/array and got redacted to a string, we may want to consider if that's correct.
            // For simplicity, we just store the redacted string.
            result[k] = redacted
          } else {
            // Scrub the value recursively
            result[k] = this.scrub([...path, k], v, notes)
          }
        }
      }
      return result
    }

    return value
  }
}

/**
 * A no-op attribute scrubber that returns values unchanged.
 * Useful when you want to disable scrubbing entirely.
 */
export class NoopAttributeScrubber implements AttributeScrubber {
  /**
   * Returns the value unchanged with no scrubbing notes.
   * @param path The JSON path to this value.
   * @param value The value to return unchanged.
   * @returns A tuple: [originalValue, emptyNotes]
   */
  scrubValue<T>(_path: JsonPath, value: T): readonly [T, ScrubbedNote[]] {
    return [value, []] as const
  }
}
