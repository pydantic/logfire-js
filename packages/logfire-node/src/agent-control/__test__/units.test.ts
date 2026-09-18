import { describe, expect, it } from 'vite-plus/test'

import { isRepresentableTimeout, MAX_TIMEOUT_MILLISECONDS, MAX_TIMEOUT_SECONDS, toMilliseconds } from '../index'

describe('isRepresentableTimeout', () => {
  it('accepts a finite, non-negative budget a 32-bit timer can hold', () => {
    expect(isRepresentableTimeout(0)).toBe(true)
    expect(isRepresentableTimeout(0.0005)).toBe(true)
    expect(isRepresentableTimeout(30)).toBe(true)
    expect(isRepresentableTimeout(MAX_TIMEOUT_SECONDS)).toBe(true)
  })

  it('refuses everything that would make a request behave in a way nobody published', () => {
    // Each of these is a different lie: cancelled before it was sent, never cancelled, or a delay
    // that wraps a signed 32-bit timer into firing at once.
    expect(isRepresentableTimeout(-1)).toBe(false)
    expect(isRepresentableTimeout(Number.NaN)).toBe(false)
    expect(isRepresentableTimeout(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isRepresentableTimeout(MAX_TIMEOUT_SECONDS + 1)).toBe(false)
  })
})

describe('toMilliseconds', () => {
  it('rounds half up, which is the rounding both cores agree on', () => {
    expect(toMilliseconds(30)).toBe(30_000)
    expect(toMilliseconds(0.0025)).toBe(3)
    expect(toMilliseconds(MAX_TIMEOUT_SECONDS)).toBe(MAX_TIMEOUT_MILLISECONDS)
  })

  it('never rounds a positive budget down to "already expired"', () => {
    // `AbortSignal.timeout(0)` fires immediately, so quantizing 0.5ms to 0 would turn a very short
    // timeout into a request that cannot be made at all.
    expect(toMilliseconds(0.0004)).toBe(1)
    // An exact zero is passed through, because that is what it was published as.
    expect(toMilliseconds(0)).toBe(0)
  })

  it('throws rather than guessing at a budget it cannot represent', () => {
    // An adapter is expected to ask `isRepresentableTimeout` first and report the value under its
    // policy; reaching here means it did not, and silently clamping would be the worse answer.
    expect(() => toMilliseconds(-1)).toThrow(RangeError)
    expect(() => toMilliseconds(-1)).toThrow(/not a representable request budget/u)
  })
})
