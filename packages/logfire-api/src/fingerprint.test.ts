import { describe, expect, test } from 'vitest'

import { canonicalizeError, computeFingerprint } from './fingerprint'

describe('canonicalizeError', () => {
  test('includes error type', () => {
    const error = new TypeError('test message')
    const canonical = canonicalizeError(error)

    expect(canonical).toContain('TypeError')
    expect(canonical).toContain('----')
  })

  test('includes function names from stack', () => {
    function innerFunction() {
      throw new Error('test')
    }
    function outerFunction() {
      innerFunction()
    }

    let canonical = ''
    try {
      outerFunction()
    } catch (e) {
      canonical = canonicalizeError(e as Error)
    }

    expect(canonical).toContain('innerFunction')
    expect(canonical).toContain('outerFunction')
  })

  test('handles error.cause chain', () => {
    const cause = new Error('root cause')
    const error = new Error('wrapper', { cause })

    const canonical = canonicalizeError(error)

    expect(canonical).toContain('----CAUSE----')
    expect(canonical.split('----CAUSE----').length).toBe(2)
  })

  test('handles AggregateError', () => {
    const errors = [new Error('first'), new TypeError('second')]
    const aggregate = new AggregateError(errors, 'multiple errors')

    const canonical = canonicalizeError(aggregate)

    expect(canonical).toContain('AggregateError')
    expect(canonical).toContain('----AGGREGATE----')
    expect(canonical).toContain('Error')
    expect(canonical).toContain('TypeError')
  })

  test('handles circular cause references', () => {
    const error1 = new Error('error 1')
    const error2 = new Error('error 2', { cause: error1 })
    ;(error1 as Error & { cause: Error }).cause = error2

    const canonical = canonicalizeError(error1)

    expect(canonical).toContain('[circular]')
  })

  test('deduplicates repeated frames (recursion)', () => {
    function recursiveFunction(depth: number): never {
      if (depth > 0) {
        recursiveFunction(depth - 1)
      }
      throw new Error('recursion error')
    }

    let canonical = ''
    try {
      recursiveFunction(5)
    } catch (e) {
      canonical = canonicalizeError(e as Error)
    }

    const matches = canonical.match(/recursiveFunction/g)
    expect(matches?.length).toBe(1)
  })

  test('does not include error message in canonical form', () => {
    const error = new Error('this message should not appear')
    const canonical = canonicalizeError(error)

    expect(canonical).not.toContain('this message should not appear')
  })
})

describe('computeFingerprint', () => {
  test('returns 64 character hex string (SHA-256)', async () => {
    const error = new Error('test')
    const fingerprint = await computeFingerprint(error)

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  test('same canonical form produces same fingerprint', async () => {
    const error1 = new Error('message 1')
    const error2 = new Error('message 2')

    error1.stack = `Error: message 1
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    error2.stack = `Error: message 2
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    const fp1 = await computeFingerprint(error1)
    const fp2 = await computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('different error types produce different fingerprints', async () => {
    const error1 = new Error('test')
    const error2 = new TypeError('test')

    error1.stack = `Error: test
    at testFunction (test.js:10:5)`

    error2.stack = `TypeError: test
    at testFunction (test.js:10:5)`

    const fp1 = await computeFingerprint(error1)
    const fp2 = await computeFingerprint(error2)

    expect(fp1).not.toBe(fp2)
  })

  test('different stack produces different fingerprint', async () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at locationA (test.js:10:5)`

    error2.stack = `Error: test
    at locationB (test.js:10:5)`

    const fp1 = await computeFingerprint(error1)
    const fp2 = await computeFingerprint(error2)

    expect(fp1).not.toBe(fp2)
  })

  test('line numbers do not affect fingerprint', async () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    error2.stack = `Error: test
    at testFunction (test.js:999:5)
    at main (test.js:888:3)`

    const fp1 = await computeFingerprint(error1)
    const fp2 = await computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('file paths are normalized for portability', async () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at testFunction (/home/user/project/src/utils/helper.ts:10:5)`

    error2.stack = `Error: test
    at testFunction (/different/path/project/src/utils/helper.ts:10:5)`

    const fp1 = await computeFingerprint(error1)
    const fp2 = await computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('handles anonymous stack frames without function names', async () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at file:///home/user/project/src/utils/helper.js:10:5
    at otherFunction (other.js:20:3)`

    error2.stack = `Error: test
    at file:///different/path/src/utils/helper.js:10:5
    at otherFunction (other.js:20:3)`

    const fp1 = await computeFingerprint(error1)
    const fp2 = await computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })
})
