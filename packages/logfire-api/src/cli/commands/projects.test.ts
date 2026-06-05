import { describe, expect, it } from 'vite-plus/test'

import { sanitizeProjectName } from './projects'

describe('sanitizeProjectName', () => {
  // Ported from Python `tests/test_configure.py::test_sanitize_project_name` to keep
  // the default project name suggested by the JS and Python CLIs identical.
  it('matches the Python sanitizer behavior', () => {
    expect(sanitizeProjectName('foo')).toBe('foo')
    expect(sanitizeProjectName('FOO')).toBe('foo')
    expect(sanitizeProjectName('  foo - bar!!')).toBe('foobar')
    expect(sanitizeProjectName('  Foo - BAR!!')).toBe('foobar')
    expect(sanitizeProjectName('')).toBe('untitled')
    expect(sanitizeProjectName('-')).toBe('untitled')
    expect(sanitizeProjectName('...')).toBe('untitled')
    const longName = 'abcdefg'.repeat(20)
    expect(sanitizeProjectName(longName)).toBe(longName.slice(0, 41))
  })
})
