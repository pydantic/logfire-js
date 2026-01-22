interface StackFrame {
  fileName?: string
  functionName: string
}

const V8_PATTERNS = [/^\s*at\s+(.+?)\s+\((.+?):\d+:\d+\)/, /^\s*at\s+(.+?):\d+:\d+/, /^\s*at\s+(.+?)\s+\((.+?)\)/, /^\s*at\s+(.+)/]
const FIREFOX_PATTERN = /^(.+?)@(.+?):\d+:\d+/

/**
 * Parses a JavaScript stack trace string into structured frames.
 *
 * Handles common stack trace formats:
 * - V8/Node.js: "    at functionName (file:line:col)" or "    at file:line:col"
 * - Firefox: "functionName@file:line:col"
 */
function parseStackFrames(stack: string | undefined): StackFrame[] {
  if (!stack) return []

  const frames: StackFrame[] = []
  const lines = stack.split('\n').slice(1)

  for (const line of lines) {
    let v8Match: null | RegExpExecArray = null
    for (const pattern of V8_PATTERNS) {
      v8Match = pattern.exec(line)
      if (v8Match) break
    }

    const firefoxMatch = FIREFOX_PATTERN.exec(line)

    if (v8Match) {
      frames.push({
        fileName: v8Match[2] ? extractModuleName(v8Match[2]) : undefined,
        functionName: v8Match[1] ?? '<anonymous>',
      })
    } else if (firefoxMatch?.[2]) {
      frames.push({
        fileName: extractModuleName(firefoxMatch[2]),
        functionName: firefoxMatch[1] ?? '<anonymous>',
      })
    }
  }

  return frames
}

/**
 * Extracts a module-like name from a file path for stable fingerprinting.
 * Removes absolute path prefixes and file extensions to make fingerprints
 * portable across different environments.
 */
function extractModuleName(filePath: string): string {
  return (
    filePath
      // Remove file:// protocol
      .replace(/^file:\/\//, '')
      // Remove node_modules path prefix, keep package name
      .replace(/^.*?\/node_modules\//, '')
      // Keep path relative to src/
      .replace(/^.*?\/(src\/)/, '$1')
      // Remove common extensions
      .replace(/\.[jt]sx?$/, '')
      // Remove query strings (for bundled code)
      .replace(/\?.*$/, '')
  )
}

/**
 * Creates a canonical string representation of an error for fingerprinting.
 *
 * The canonical format is designed for stability:
 * - Uses error type (constructor name)
 * - Uses function names from stack frames
 * - Deduplicates repeated frames (handles recursion)
 * - Includes error.cause chain
 * - Handles AggregateError by sorting and including all errors
 *
 * Line numbers are intentionally excluded since they change frequently
 * when code is edited, but the same logical error should produce the
 * same fingerprint.
 */
export function canonicalizeError(error: Error, seen = new WeakSet<Error>()): string {
  if (seen.has(error)) {
    return '[circular]'
  }
  seen.add(error)

  const lines: string[] = []

  lines.push(error.constructor.name || 'Error')
  lines.push('----')

  const frames = parseStackFrames(error.stack)
  const seenFrames = new Set<string>()

  for (const frame of frames) {
    const frameKey = `${frame.functionName}|${frame.fileName ?? ''}`
    if (seenFrames.has(frameKey)) continue
    seenFrames.add(frameKey)

    if (frame.fileName) {
      lines.push(`${frame.fileName}:${frame.functionName}`)
    } else {
      lines.push(frame.functionName)
    }
  }

  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    const errorStrings = error.errors
      .filter((e): e is Error => e instanceof Error)
      .map((e) => canonicalizeError(e, seen))
      .sort()

    if (errorStrings.length > 0) {
      lines.push('----AGGREGATE----')
      lines.push(errorStrings.join('\n----\n'))
    }
  }

  if (error.cause instanceof Error) {
    lines.push('----CAUSE----')
    lines.push(canonicalizeError(error.cause, seen))
  }

  return lines.join('\n')
}

/**
 * Computes SHA-256 hash of a string using Web Crypto API.
 * Works in Node.js 19+, browsers, Cloudflare Workers, and Deno.
 */
async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Computes a fingerprint for an error that can be used to group
 * similar errors into issues.
 *
 * The fingerprint is a SHA-256 hash of the canonicalized error representation.
 * Errors with the same stack trace structure (ignoring line numbers) will
 * produce the same fingerprint.
 */
export async function computeFingerprint(error: Error): Promise<string> {
  const canonical = canonicalizeError(error)
  return sha256(canonical)
}
