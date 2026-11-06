// A registry symbol because `@pydantic/logfire-session-replay` brands its errors too, and it does
// not depend on this package.
const SDK_INTERNAL_ERROR = Symbol.for('logfire.sdk.internal')

/**
 * Brands an error the SDK raised about itself, so the exception span reports it with
 * `logfire.sdk.internal`. The brand is on the error rather than on the path that reports it, because
 * application errors take the same paths. Call this with `new Error()` in place, since a factory
 * would add a stack frame and change the fingerprint of the error.
 *
 * @internal
 */
export function markSdkInternalError<E extends Error>(error: E): E {
  Object.defineProperty(error, SDK_INTERNAL_ERROR, { value: true })
  return error
}

/** @internal */
export function isSdkInternalError(error: unknown): boolean {
  try {
    return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[SDK_INTERNAL_ERROR] === true
  } catch {
    // A hostile proxy must not prevent the report.
    return false
  }
}
