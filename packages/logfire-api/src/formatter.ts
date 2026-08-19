import type { BaseScrubber, ScrubbedNote } from './AttributeScrubber'
import { ATTRIBUTES_SCRUBBED_KEY, MESSAGE_FORMATTED_VALUE_LENGTH_LIMIT } from './constants'

// TypeScript equivalent of Python's TypedDict
interface LiteralChunk {
  type: 'lit'
  value: string
}

interface ArgChunk {
  spec?: string
  type: 'arg'
  value: string
}

class KnownFormattingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnownFormattingError'
  }
}

class ChunksFormatter {
  chunks(
    formatString: string,
    record: Record<string, unknown>,
    scrubber: BaseScrubber
  ): [(ArgChunk | LiteralChunk)[], Record<string, unknown>, string] {
    // TypeScript equivalent doesn't need f-string introspection as JavaScript template literals
    // are evaluated before the function is called

    const [chunks, extraAttrs] = this.vformatChunks(formatString, record, scrubber)

    // In TypeScript/JavaScript we don't need to handle f-strings separately
    return [chunks, extraAttrs, formatString]
  }

  // Format a single field value
  formatField(value: unknown, formatSpec: string): string {
    // Very simplified version - TypeScript doesn't have Python's rich formatting system
    if (!formatSpec) {
      return String(value)
    }

    // Simple number formatting for demonstration
    if (typeof value === 'number') {
      if (formatSpec.includes('.')) {
        const [, precision] = formatSpec.split('.') as [string, string]
        return value.toFixed(parseInt(precision, 10))
      }
    }

    // Default to string conversion
    return String(value)
  }

  // Equivalent to Python's getField method
  getField(fieldName: string, record: Record<string, unknown>): [unknown, string] {
    // A literal attribute key always wins, so OTel-style dotted names like
    // "http.method" keep resolving even when nested traversal is possible.
    // Object.hasOwn keeps prototype members like `toString` from resolving.
    if (Object.hasOwn(record, fieldName)) {
      return [record[fieldName], fieldName]
    }

    if (fieldName.includes('.')) {
      // Handle nested field access like "a.b" by walking into the record value
      const parts = fieldName.split('.')
      const firstKey = parts[0] ?? ''
      if (!Object.hasOwn(record, firstKey)) {
        throw new KnownFormattingError(`The field ${fieldName} is not defined.`)
      }
      let obj: unknown = record[firstKey]
      for (let i = 1; i < parts.length; i++) {
        const key = parts[i] ?? ''
        if (typeof obj === 'object' && obj !== null && Object.hasOwn(obj, key)) {
          obj = (obj as Record<string, unknown>)[key]
        } else {
          throw new KnownFormattingError(`The field ${fieldName} is not defined.`)
        }
      }
      return [obj, firstKey]
    }

    throw new KnownFormattingError(`The field ${fieldName} is not defined.`)
  }

  parse(formatString: string): [string, null | string, null | string, null | string][] {
    // Internal regex to parse format strings (similar to Python's Formatter.parse).
    // Keep it local so the global flag's `lastIndex` state cannot leak between parses.
    const parseRegex = /(\{\{)|(\}\})|(\{([^{}]*)(?::([^{}]*))?\})/gu
    const result: [string, null | string, null | string, null | string][] = []
    let lastIndex = 0
    let literalText = ''

    let match: null | RegExpExecArray
    while ((match = parseRegex.exec(formatString)) !== null) {
      const [fullMatch, doubleLBrace, doubleRBrace, curlyContent, fieldName, formatSpec] = match

      // Get literal text before the match
      const precedingText = formatString.substring(lastIndex, match.index)
      literalText += precedingText

      if (doubleLBrace !== undefined) {
        // {{ is escaped to {
        literalText += '{'
      } else if (doubleRBrace !== undefined) {
        // }} is escaped to }
        literalText += '}'
      } else if (curlyContent !== undefined) {
        // Found a field, add the accumulated literal text and the field info
        result.push([literalText, fieldName ?? null, formatSpec ?? null, null])
        literalText = ''
      }

      lastIndex = match.index + fullMatch.length
    }

    // Add any remaining literal text
    if (lastIndex < formatString.length) {
      literalText += formatString.substring(lastIndex)
    }

    if (literalText !== '') {
      result.push([literalText, null, null, null])
    }

    return result
  }

  private cleanValue(fieldName: string, value: string, scrubber: BaseScrubber): [string, ScrubbedNote[]] {
    // Scrub before truncating so the scrubber can see the full value
    if (scrubber.SAFE_KEYS.includes(fieldName)) {
      return [truncateString(value, MESSAGE_FORMATTED_VALUE_LENGTH_LIMIT), []]
    }

    const [cleanValue, scrubbed] = scrubber.scrubValue(['message', fieldName], value)

    return [truncateString(cleanValue, MESSAGE_FORMATTED_VALUE_LENGTH_LIMIT), scrubbed]
  }

  private vformatChunks(
    formatString: string,
    record: Record<string, unknown>,
    scrubber: BaseScrubber,
    recursionDepth = 2
  ): [(ArgChunk | LiteralChunk)[], Record<string, unknown>] {
    if (recursionDepth < 0) {
      throw new KnownFormattingError('Max format spec recursion exceeded')
    }

    const result: (ArgChunk | LiteralChunk)[] = []
    const scrubbed: ScrubbedNote[] = []

    for (const [literalText, fieldName, formatSpec] of this.parse(formatString)) {
      // Output the literal text
      if (literalText) {
        result.push({ type: 'lit', value: literalText })
      }

      // If there's a field, output it
      if (fieldName !== null) {
        // Handle markup and formatting
        if (fieldName === '') {
          throw new KnownFormattingError('Empty curly brackets `{}` are not allowed. A field name is required.')
        }

        // Handle debug format like "{field=}"
        let actualFieldName = fieldName
        if (fieldName.endsWith('=')) {
          const lastResult = result[result.length - 1] ?? null
          if (lastResult?.type === 'lit') {
            lastResult.value += fieldName
          } else {
            result.push({ type: 'lit', value: fieldName })
          }
          actualFieldName = fieldName.slice(0, -1)
        }

        // Get the object referenced by the field name
        let obj
        try {
          ;[obj] = this.getField(actualFieldName, record)
        } catch (err) {
          if (err instanceof KnownFormattingError) {
            throw err
          }
          throw new KnownFormattingError(`Error getting field ${actualFieldName}: ${String(err)}`)
        }

        // Format the field value
        let formattedValue
        try {
          formattedValue = this.formatField(obj, formatSpec ?? '')
        } catch (err) {
          throw new KnownFormattingError(`Error formatting field ${actualFieldName}: ${String(err)}`)
        }

        // Clean and scrub the value
        const [cleanValue, valueScrubbed] = this.cleanValue(actualFieldName, formattedValue, scrubber)
        scrubbed.push(...valueScrubbed)

        const argChunk: ArgChunk = { type: 'arg', value: cleanValue }
        if (formatSpec !== null && formatSpec !== '') {
          argChunk.spec = formatSpec
        }
        result.push(argChunk)
      }
    }

    const extraAttrs = scrubbed.length > 0 ? { [ATTRIBUTES_SCRUBBED_KEY]: scrubbed } : {}
    return [result, extraAttrs]
  }
}

// Create singleton instance
export const chunksFormatter: ChunksFormatter = new ChunksFormatter()

/**
 * Format a string with additional information about attributes and templates
 */
export function logfireFormatWithExtras(
  formatString: string,
  record: Record<string, unknown>,
  scrubber: BaseScrubber
): {
  extraAttributes: Record<string, unknown>
  formattedMessage: string
  newTemplate: string
} {
  try {
    const [chunks, extraAttributes, newTemplate] = chunksFormatter.chunks(formatString, record, scrubber)

    const formattedMessage = chunks.map((chunk) => chunk.value).join('')
    return {
      extraAttributes,
      formattedMessage,
      newTemplate,
    }
  } catch (err) {
    if (err instanceof KnownFormattingError) {
      console.warn(`Formatting error: ${err.message}`)
    } else {
      console.error('Unexpected error during formatting:', err)
    }

    // Formatting failed, use the original format string as the message
    return {
      extraAttributes: {},
      formattedMessage: formatString,
      newTemplate: formatString,
    }
  }
}

/**
 * Truncates a string if it exceeds the specified maximum length.
 *
 * @param str The string to truncate
 * @param maxLength The maximum allowed length
 * @returns The truncated string
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str
  }

  return str.substring(0, floorCodePointBoundary(str, maxLength - 3)) + '...'
}

/**
 * Largest index at or below `index` that does not fall between the halves of a
 * surrogate pair. Slicing counts UTF-16 code units, so an unadjusted cut can keep
 * only the high half of an astral character, and a lone surrogate has no UTF-8
 * encoding once the value is serialized. Use for `str.slice(0, index)`.
 */
export function floorCodePointBoundary(str: string, index: number): number {
  const code = str.charCodeAt(index - 1)
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index
}

/**
 * Smallest index at or above `index` that does not fall between the halves of a
 * surrogate pair. The mirror of `floorCodePointBoundary`, for `str.slice(index)`,
 * whose start can land on the low half of a pair.
 */
export function ceilCodePointBoundary(str: string, index: number): number {
  const code = str.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index
}
