/**
 * What the contract's one dimensioned setting means, and how to convert it without surprises.
 *
 * `timeout` is the only canonical setting carrying a unit, and it is the only one an adapter has to
 * convert before it can be used: `AbortSignal.timeout`, `fetch` wrappers, and most CLI flags want
 * integer milliseconds. Left to each adapter, that conversion has already drifted three ways -- one
 * truncating, one rounding, one passing a fraction of a millisecond straight into an API that throws
 * on it -- so the range and the rounding are defined here, once, and the cores share these rules.
 */

/**
 * The largest delay a timer can be given: `2 ** 31 - 1` ms, about 24.9 days.
 *
 * Not an opinion about sensible timeouts, but the smallest ceiling the targets share. Browsers,
 * Node, and `AbortSignal.timeout` all take a signed 32-bit millisecond delay, and a larger one
 * silently wraps or fires immediately -- which is the failure mode a managed setting must never
 * introduce, since it turns "no real limit" into "cancel at once".
 */
export const MAX_TIMEOUT_MILLISECONDS: number = 2 ** 31 - 1

/** `MAX_TIMEOUT_MILLISECONDS` as the seconds the contract states timeouts in. */
export const MAX_TIMEOUT_SECONDS: number = MAX_TIMEOUT_MILLISECONDS / 1000

/**
 * Whether a published `timeout` is a request budget an adapter can actually install.
 *
 * A timeout is representable when it is a finite, non-negative number of seconds no larger than
 * `MAX_TIMEOUT_SECONDS`. Everything else -- a negative budget, a `NaN` that compares false against
 * every deadline, an `Infinity` or an oversized value that wraps a 32-bit timer -- is refused rather
 * than clamped, because each of them would make a request behave in a way nobody published: silently
 * unlimited, or cancelled before it was sent.
 *
 * `0` is representable and means exactly what it says: a budget of no time at all.
 */
export function isRepresentableTimeout(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_TIMEOUT_SECONDS
}

/**
 * A representable `timeout` in the integer milliseconds most SDKs and timers want.
 *
 * Rounded half up -- `Math.floor(seconds * 1000 + 0.5)` -- which is the one rounding this core and
 * the Python one agree on for non-negative values, so both return the same integer for the same
 * published value. (`Math.round` agrees for these inputs; it is spelled out because Python's own
 * `round` does not, rounding halves to even.)
 *
 * A *positive* budget never rounds down to `0`: anything under half a millisecond comes back as `1`.
 * Zero milliseconds means "already expired" to a timer, so rounding a small positive budget into it
 * would turn a very short timeout into a request that cannot be made at all. An exact `0` is passed
 * through, since that is what it was published as.
 *
 * @throws If `seconds` is not representable; see `isRepresentableTimeout`, which is what an adapter
 * should call first so the value is reported under its `onUnmatched` policy rather than thrown at
 * conversion time.
 */
export function toMilliseconds(seconds: number): number {
  if (!isRepresentableTimeout(seconds)) {
    throw new RangeError(
      `Timeout ${String(seconds)} is not a representable request budget: it has to be a finite, ` +
        `non-negative number of seconds no larger than ${String(MAX_TIMEOUT_SECONDS)}.`
    )
  }
  const milliseconds = Math.floor(seconds * 1000 + 0.5)
  return seconds > 0 ? Math.max(milliseconds, 1) : milliseconds
}
