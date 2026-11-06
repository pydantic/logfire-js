// The brand that `logfire` reads to set `logfire.sdk.internal`. A registry symbol keeps this package
// usable without `logfire`, which is why the helper is not imported from there.
const SDK_INTERNAL_ERROR = Symbol.for('logfire.sdk.internal')

/** Brands an error this package raised about itself. Call it with `new Error()` in place, to keep the stack and its fingerprint. */
export function markSdkInternalError<E extends Error>(error: E): E {
  Object.defineProperty(error, SDK_INTERNAL_ERROR, { value: true })
  return error
}
