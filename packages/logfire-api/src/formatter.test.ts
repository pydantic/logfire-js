import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { NoopScrubber } from './AttributeScrubber'
import { logfireFormatWithExtras, truncateString } from './formatter'

function format(template: string, record: Record<string, unknown>): string {
  return logfireFormatWithExtras(template, record, NoopScrubber).formattedMessage
}

describe('message template nested field access', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('resolves a nested field', () => {
    expect(format('hello {user.name}', { user: { name: 'Alice' } })).toBe('hello Alice')
  })

  test('resolves a deeply nested field', () => {
    expect(format('request by {req.user.id}', { req: { user: { id: 1 } } })).toBe('request by 1')
  })

  test('nested traversal ignores unrelated top-level keys with the same trailing name', () => {
    expect(format('value is {a.b}', { a: { b: 'nested' }, b: 'top' })).toBe('value is nested')
  })

  test('a literal dotted attribute key wins over nested traversal', () => {
    expect(format('{http.method} request', { http: { method: 'nested' }, 'http.method': 'GET' })).toBe('GET request')
  })

  test('supports the debug format with nested fields', () => {
    expect(format('{user.name=}', { user: { name: 'Alice' } })).toBe('user.name=Alice')
  })

  test('falls back to the raw template when the nested field is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(format('hello {user.name}', { user: {} })).toBe('hello {user.name}')
    expect(warn).toHaveBeenCalledWith('Formatting error: The field user.name is not defined.')
  })

  test('falls back to the raw template when the root of a nested field is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(format('hello {user.name}', { other: 1 })).toBe('hello {user.name}')
    expect(warn).toHaveBeenCalledWith('Formatting error: The field user.name is not defined.')
  })

  test('falls back to the raw template when an intermediate value is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(format('{a.b}', { a: 5 })).toBe('{a.b}')
    expect(warn).toHaveBeenCalledWith('Formatting error: The field a.b is not defined.')
  })

  test('plain top-level fields keep working', () => {
    expect(format('hello {name}', { name: 'Bob' })).toBe('hello Bob')
  })

  test('nested traversal does not resolve prototype members', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(format('{user.toString}', { user: {} })).toBe('{user.toString}')
    expect(warn).toHaveBeenCalledWith('Formatting error: The field user.toString is not defined.')
  })

  test('top-level lookup does not resolve prototype members', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(format('{toString}', { name: 'Bob' })).toBe('{toString}')
    expect(warn).toHaveBeenCalledWith('Formatting error: The field toString is not defined.')
  })

  test('bracket syntax with no matching literal key falls back to the raw template', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(format('first item is {a[0]}', { a: ['zero'] })).toBe('first item is {a[0]}')
    expect(warn).toHaveBeenCalledWith('Formatting error: The field a[0] is not defined.')
  })

  test('a literal attribute key containing brackets keeps resolving', () => {
    expect(format('first item is {a[0]}', { 'a[0]': 'zero' })).toBe('first item is zero')
  })
})

describe('truncateString', () => {
  test('does not split a surrogate pair at either cut', () => {
    // Both ends are kept now, so there are two cuts to land wrong. An emoji straddles each one:
    // the head cut at 48 and the tail cut at length - 48. A code-unit slice would keep the high
    // half of the first and the low half of the second.
    const value = `${'a'.repeat(47)}\u{1F600}${'m'.repeat(30)}\u{1F600}${'b'.repeat(47)}`
    const truncated = truncateString(value, 100)

    expect(truncated).toBe(`${'a'.repeat(47)}...${'b'.repeat(47)}`)
    expect(truncated.split('').some((char) => char >= '\uD800' && char <= '\uDFFF')).toBe(false)
    expect(JSON.stringify(truncated).includes('\\ud')).toBe(false)
  })

  test('keeps both ends when the boundaries are not surrogates', () => {
    // Python's `truncate_string` is `seq[:half] + middle + seq[-half:]`, so the tail survives and
    // the result can be one shorter than the limit when the remainder is odd.
    expect(truncateString(`${'a'.repeat(60)}${'b'.repeat(60)}`, 100)).toBe(`${'a'.repeat(48)}...${'b'.repeat(48)}`)
    expect(truncateString('short', 100)).toBe('short')
  })
})
