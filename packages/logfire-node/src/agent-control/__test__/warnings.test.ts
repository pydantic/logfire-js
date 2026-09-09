import { describe, expect, it } from 'vite-plus/test'

import { UnmatchedConfigError } from '../index'
import { repr, reportUnmatched, warnOnce } from '../warnings'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

describe('warnOnce', () => {
  it('emits a message once per process, and a different one still gets through', () => {
    warnOnce('first')
    warnOnce('first')
    warnOnce('second')
    expect(warnings.messages).toEqual(['first', 'second'])
  })
})

describe('reportUnmatched', () => {
  it('carries the same message under every policy that says anything', () => {
    const message = 'the entry reached nothing'
    reportUnmatched('ignore', message)
    expect(warnings.messages).toEqual([])
    reportUnmatched('warn', message)
    expect(warnings.messages).toEqual([message])
    expect(() => {
      reportUnmatched('error', message)
    }).toThrow(new UnmatchedConfigError(message))
  })
})

describe('repr', () => {
  it('renders a value the way the message on the other SDK renders it', () => {
    expect(repr('text')).toBe("'text'")
    expect(repr("it's")).toBe("'it\\'s'")
    expect(repr('a\\b')).toBe("'a\\\\b'")
    expect(repr(null)).toBe('None')
    expect(repr(undefined)).toBe('None')
    expect(repr(true)).toBe('True')
    expect(repr(false)).toBe('False')
    expect(repr(42)).toBe('42')
    expect(repr(1n)).toBe('1')
    expect(repr({ a: 1 })).toBe('{"a":1}')
    expect(repr([1, 'two'])).toBe('[1,"two"]')
  })

  it('falls back to a plain string for a value JSON cannot render', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular['self'] = circular
    expect(repr(circular)).toBe('[object Object]')
    // `JSON.stringify` returns `undefined` rather than throwing for a lone function.
    expect(repr(() => 1)).toBe('() => 1')
  })
})
