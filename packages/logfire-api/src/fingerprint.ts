import { murmurhash3x64128 } from './murmurhash'

interface StackFrame {
  fileName?: string
  functionName: string
}

const V8_PATTERN_WITH_PARENS = /^\s*at\s+(.+?)\s+\((.+?):\d+:\d+\)/
const V8_PATTERN_NO_PARENS = /^\s*at\s+(.+?):\d+:\d+/
const V8_PATTERN_EVAL = /^\s*at\s+(.+?)\s+\((.+?)\)/
const V8_PATTERN_BARE = /^\s*at\s+(.+)/
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
    const withParensMatch = V8_PATTERN_WITH_PARENS.exec(line)
    const noParensMatch = V8_PATTERN_NO_PARENS.exec(line)
    const evalMatch = V8_PATTERN_EVAL.exec(line)
    const bareMatch = V8_PATTERN_BARE.exec(line)
    const firefoxMatch = FIREFOX_PATTERN.exec(line)

    if (withParensMatch?.[1] && withParensMatch[2]) {
      frames.push({
        fileName: extractModuleName(withParensMatch[2]),
        functionName: withParensMatch[1],
      })
    } else if (noParensMatch?.[1]) {
      frames.push({
        fileName: extractModuleName(noParensMatch[1]),
        functionName: '<anonymous>',
      })
    } else if (evalMatch?.[1] && evalMatch[2]) {
      frames.push({
        fileName: extractModuleName(evalMatch[2]),
        functionName: evalMatch[1],
      })
    } else if (bareMatch?.[1]) {
      frames.push({
        fileName: undefined,
        functionName: bareMatch[1],
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
  return filePath
    .replace(/^file:\/\//, '')
    .replace(/^.*?\/node_modules\//, '')
    .replace(/^.*?\/(src\/)/, '$1')
    .replace(/\.[jt]sx?$/, '')
    .replace(/\?.*$/, '')
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
 * Computes a fingerprint for an error that can be used to group
 * similar errors into issues.
 *
 * The fingerprint is a MurmurHash3 128-bit hash of the canonicalized error representation.
 * Errors with the same stack trace structure (ignoring line numbers) will
 * produce the same fingerprint.
 */
export function computeFingerprint(error: Error): string {
  const canonical = canonicalizeError(error)
  return murmurhash3x64128(canonical)
}
