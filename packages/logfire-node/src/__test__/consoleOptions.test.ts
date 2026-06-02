import { describe, expect, it } from 'vite-plus/test'

import { Level } from 'logfire'

import { resolveConsoleOptions } from '../consoleOptions'

describe('resolveConsoleOptions', () => {
  it('disables console output when omitted or false', () => {
    expect(resolveConsoleOptions(undefined)).toEqual({
      enabled: false,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Info,
    })
    expect(resolveConsoleOptions(false)).toEqual({
      enabled: false,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Info,
    })
  })

  it('uses Python-like defaults when enabled with a boolean or object', () => {
    expect(resolveConsoleOptions(true)).toEqual({
      enabled: true,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Info,
    })
    expect(resolveConsoleOptions({})).toEqual({
      enabled: true,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Info,
    })
  })

  it('lets object config disable console output', () => {
    expect(resolveConsoleOptions({ enabled: false, minLevel: 'error' })).toEqual({
      enabled: false,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Error,
    })
  })

  it('resolves explicit options', () => {
    expect(
      resolveConsoleOptions({
        includeTags: false,
        includeTimestamps: false,
        minLevel: ' WARNING ' as 'warning',
      })
    ).toEqual({
      enabled: true,
      includeTags: false,
      includeTimestamps: false,
      minLevel: Level.Warning,
    })

    expect(resolveConsoleOptions({ minLevel: Level.Debug }).minLevel).toBe(Level.Debug)
  })

  it('rejects invalid console min levels', () => {
    expect(() => resolveConsoleOptions({ minLevel: 'warn' as never })).toThrow('Invalid console.minLevel')
    expect(() => resolveConsoleOptions({ minLevel: 12 as never })).toThrow('Invalid console.minLevel')
  })

  it('validates minLevel even when object config disables output', () => {
    expect(() => resolveConsoleOptions({ enabled: false, minLevel: 'warn' as never })).toThrow('Invalid console.minLevel')
  })
})
