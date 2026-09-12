import { describe, expect, it } from 'vite-plus/test'

import { UnmatchedConfigError } from '../index'
import { droppedByProvider, repr, reportIssues, reportUnmatched, warnOnce } from '../warnings'
import type { ApplyIssue } from '../warnings'
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

describe('droppedByProvider', () => {
  it('takes the two things every SDK warning shape carries, so the core knows none of them', () => {
    // Discovered *after* the request, by an adapter reading its own SDK's warnings, which is why the
    // core cannot find this one for itself.
    const issue = droppedByProvider('top_k', 'unsupported by this model')
    expect(issue).toEqual({
      section: 'settings',
      reason: 'dropped-by-provider',
      setting: 'top_k',
      message:
        "Managed agent config sets 'top_k', which the provider did not apply -- unsupported by this " +
        'model; that key had no effect on the request.',
    })
  })
})

describe('reportIssues', () => {
  const first: ApplyIssue = { section: 'settings', reason: 'unknown-setting', setting: 'a', message: 'first' }
  const second: ApplyIssue = { section: 'model', reason: 'unsupported-section', message: 'second' }

  it('warns every issue, once per process per message', () => {
    reportIssues('warn', [first, second])
    reportIssues('warn', [first])
    expect(warnings.messages).toEqual(['first', 'second'])
  })

  it('throws once, naming every issue and carrying them, rather than on the first', () => {
    // `'error'` used to throw inside the first section's apply call, so the other sections were
    // never planned: the strictest policy reported the least.
    let thrown: unknown
    try {
      reportIssues('error', [first, second])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UnmatchedConfigError)
    expect((thrown as UnmatchedConfigError).message).toBe('first\nsecond')
    expect((thrown as UnmatchedConfigError).issues).toEqual([first, second])
  })

  it('says nothing under ignore, and nothing at all for no issues', () => {
    reportIssues('ignore', [first])
    reportIssues('error', [])
    expect(warnings.messages).toEqual([])
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
