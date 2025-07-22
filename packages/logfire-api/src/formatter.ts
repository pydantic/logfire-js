import { BaseScrubber, ScrubbedNote } from './AttributeScrubber'
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
  // Internal regex to parse format strings (similar to Python's Formatter.parse)
  private parseRegex = /(\{\{)|(\}\})|(\{([^{}]*)(?::([^{}]*))?\})/g

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
    if (fieldName.includes('.') || fieldName.includes('[')) {
      // Handle nested field access like "a.b" or "a[b]"
      try {
        // Simple nested property access (this is a simplification)
        const parts = fieldName.split('.')
        let obj = record[parts[0] ?? '']
        for (let i = 1; i < parts.length; i++) {
          const key = parts[i] ?? ''
          if (key in record) {
            obj = record[key]
          } else {
            throw new KnownFormattingError(`The field ${fieldName} is not an object.`)
          }
        }
        return [obj, parts[0] ?? '']
      } catch {
        // Try getting the whole thing from object
        if (fieldName in record) {
          return [record[fieldName], fieldName]
        }
        throw new KnownFormattingError(`The field ${fieldName} is not defined.`)
      }
    } else {
      // Simple field access
      if (fieldName in record) {
        return [record[fieldName], fieldName]
      }
      throw new KnownFormattingError(`The field ${fieldName} is not defined.`)
    }
  }

  parse(formatString: string): [string, null | string, null | string, null | string][] {
    const result: [string, null | string, null | string, null | string][] = []
    let lastIndex = 0
    let literalText = ''

    let match: null | RegExpExecArray
    while ((match = this.parseRegex.exec(formatString)) !== null) {
      const [fullMatch, doubleLBrace, doubleRBrace, curlyContent, fieldName, formatSpec] = match

      // Get literal text before the match
      const precedingText = formatString.substring(lastIndex, match.index)
      literalText += precedingText

      if (doubleLBrace) {
        // {{ is escaped to {
        literalText += '{'
      } else if (doubleRBrace) {
        // }} is escaped to }
        literalText += '}'
      } else if (curlyContent) {
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

    if (literalText) {
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
          if (lastResult !== null && lastResult.type === 'lit') {
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
        if (formatSpec) {
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
export const chunksFormatter = new ChunksFormatter()

/**
 * Format a string using a Python-like template syntax
 */
export function logfireFormat(formatString: string, record: Record<string, unknown>, scrubber: BaseScrubber): string {
  return logfireFormatWithExtras(formatString, record, scrubber)[0]
}

/**
 * Format a string with additional information about attributes and templates
 */
export function logfireFormatWithExtras(
  formatString: string,
  record: Record<string, unknown>,
  scrubber: BaseScrubber
): [string, Record<string, unknown>, string] {
  try {
    const [chunks, extraAttrs, newTemplate] = chunksFormatter.chunks(formatString, record, scrubber)

    return [chunks.map((chunk) => chunk.value).join(''), extraAttrs, newTemplate]
  } catch (err) {
    if (err instanceof KnownFormattingError) {
      console.warn(`Formatting error: ${err.message}`)
    } else {
      console.error('Unexpected error during formatting:', err)
    }

    // Formatting failed, use the original format string as the message
    return [formatString, {}, formatString]
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

  // Truncate and add ellipsis
  return str.substring(0, maxLength - 3) + '...'
}
