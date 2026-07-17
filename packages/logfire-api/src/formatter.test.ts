import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { NoopScrubber } from './AttributeScrubber'
import { logfireFormatWithExtras } from './formatter'

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
