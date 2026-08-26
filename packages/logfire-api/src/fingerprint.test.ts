import { describe, expect, test } from 'vite-plus/test'

import { canonicalizeError, computeFingerprint } from './fingerprint'

describe('canonicalizeError', () => {
  test('produces stable canonical form with error type and stack frames', () => {
    const error = new TypeError('test message')
    error.stack = `TypeError: test message
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    const canonical = canonicalizeError(error)

    expect(canonical).toBe(`TypeError
----
test:testFunction
test:main`)
  })

  test('drops a V8 header whose message is shaped like a Firefox frame', () => {
    // `user@example.com:12:9` matches the Firefox frame pattern, so shape alone
    // cannot tell this header from a top frame.
    const error1 = new Error('user alice@example.com:12:9 not found')
    error1.stack = `Error: user alice@example.com:12:9 not found
    at lookupUser (src/users.js:10:5)`
    const error2 = new Error('user bob@example.com:34:7 not found')
    error2.stack = `Error: user bob@example.com:34:7 not found
    at lookupUser (src/users.js:10:5)`

    expect(canonicalizeError(error1)).toBe(`Error
----
src/users:lookupUser`)
    expect(computeFingerprint(error1)).toBe(computeFingerprint(error2))
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
    cause.stack = `Error: root cause
    at causeFunction (cause.js:5:1)`

    const error = new Error('wrapper', { cause })
    error.stack = `Error: wrapper
    at wrapperFunction (wrapper.js:10:5)`

    const canonical = canonicalizeError(error)

    expect(canonical).toBe(`Error
----
wrapper:wrapperFunction
----CAUSE----
Error
----
cause:causeFunction`)
  })

  test('handles AggregateError', () => {
    const error1 = new Error('first')
    error1.stack = `Error: first
    at firstFn (first.js:1:1)`

    const error2 = new TypeError('second')
    error2.stack = `TypeError: second
    at secondFn (second.js:2:2)`

    const aggregate = new AggregateError([error1, error2], 'multiple errors')
    aggregate.stack = `AggregateError: multiple errors
    at aggregateFn (aggregate.js:10:5)`

    const canonical = canonicalizeError(aggregate)

    expect(canonical).toBe(`AggregateError
----
aggregate:aggregateFn
----AGGREGATE----
Error
----
first:firstFn
----
TypeError
----
second:secondFn`)
  })

  test('handles circular cause references', () => {
    const error1 = new Error('error 1')
    error1.stack = `Error: error 1
    at fn1 (file1.js:1:1)`

    const error2 = new Error('error 2', { cause: error1 })
    error2.stack = `Error: error 2
    at fn2 (file2.js:2:2)`
    ;(error1 as Error & { cause: Error }).cause = error2

    const canonical = canonicalizeError(error1)

    expect(canonical).toBe(`Error
----
file1:fn1
----CAUSE----
Error
----
file2:fn2
----CAUSE----
[circular]`)
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

    const matches = canonical.match(/recursiveFunction/gu)
    expect(matches?.length).toBe(1)
  })

  test('does not include error message in canonical form', () => {
    const error = new Error('this message should not appear')
    error.stack = `Error: this message should not appear
    at testFn (test.js:1:1)`

    const canonical = canonicalizeError(error)

    expect(canonical).toBe(`Error
----
test:testFn`)
  })
})

describe('computeFingerprint', () => {
  test('returns 32 character hex string (MurmurHash3 128-bit)', () => {
    const error = new Error('test')
    const fingerprint = computeFingerprint(error)

    expect(fingerprint).toMatch(/^[a-f0-9]{32}$/u)
  })

  test('same canonical form produces same fingerprint', () => {
    const error1 = new Error('message 1')
    const error2 = new Error('message 2')

    error1.stack = `Error: message 1
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    error2.stack = `Error: message 2
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('different error types produce different fingerprints', () => {
    const error1 = new Error('test')
    const error2 = new TypeError('test')

    error1.stack = `Error: test
    at testFunction (test.js:10:5)`

    error2.stack = `TypeError: test
    at testFunction (test.js:10:5)`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).not.toBe(fp2)
  })

  test('different stack produces different fingerprint', () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at locationA (test.js:10:5)`

    error2.stack = `Error: test
    at locationB (test.js:10:5)`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).not.toBe(fp2)
  })

  test('line numbers do not affect fingerprint', () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at testFunction (test.js:10:5)
    at main (test.js:20:3)`

    error2.stack = `Error: test
    at testFunction (test.js:999:5)
    at main (test.js:888:3)`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('file paths are normalized for portability', () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at testFunction (/home/user/project/src/utils/helper.ts:10:5)`

    error2.stack = `Error: test
    at testFunction (/different/path/project/src/utils/helper.ts:10:5)`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('handles anonymous stack frames without function names', () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
    at file:///home/user/project/src/utils/helper.js:10:5
    at otherFunction (other.js:20:3)`

    error2.stack = `Error: test
    at file:///different/path/src/utils/helper.js:10:5
    at otherFunction (other.js:20:3)`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).toBe(fp2)
  })

  test('keeps the top frame of a stack that has no header line', () => {
    // Firefox and Safari start at the top frame. Mocked rather than thrown, so the
    // assertion does not depend on the engine running the tests.
    const firefox = new Error('boom')
    firefox.stack = `handleClick@http://app.example/src/ui.js:12:9
submit@http://app.example/src/form.js:4:3`

    expect(canonicalizeError(firefox)).toBe(`Error
----
src/ui:handleClick
src/form:submit`)

    // Two errors that differ only in their top frame must not group together.
    const other = new Error('boom')
    other.stack = `renderChart@http://app.example/src/chart.js:88:1
submit@http://app.example/src/form.js:4:3`
    expect(computeFingerprint(firefox) === computeFingerprint(other)).toBe(false)

    // Safari writes a frame with a space in the function name.
    const safari = new Error('boom')
    safari.stack = `global code@http://app.example/src/boot.js:1:1`
    expect(canonicalizeError(safari)).toBe(`Error
----
src/boot:global code`)
  })

  test('parses Firefox stack trace format', () => {
    const error1 = new Error('test')
    const error2 = new Error('test')

    error1.stack = `Error: test
myFunction@http://example.com/src/script.js:10:5
otherFunction@http://example.com/src/script.js:20:3`

    error2.stack = `Error: test
myFunction@http://different.com/src/script.js:999:1
otherFunction@http://different.com/src/script.js:888:2`

    const fp1 = computeFingerprint(error1)
    const fp2 = computeFingerprint(error2)

    expect(fp1).toBe(fp2)

    const canonical = canonicalizeError(error1)
    expect(canonical).toBe(`Error
----
src/script:myFunction
src/script:otherFunction`)
  })
})
