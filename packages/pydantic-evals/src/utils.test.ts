import { describe, expect, test, vi } from 'vitest'

import {
  getFunctionName,
  isSet,
  PydanticEvalsDeprecationWarning,
  taskGroupGather,
  taskGroupGatherConcurrency,
  UNSET,
  warnOnce,
} from './utils'

describe('utils', () => {
  test('UNSET sentinel and isSet narrowing', () => {
    expect(isSet(UNSET)).toBe(false)
    expect(isSet('hello')).toBe(true)
    expect(isSet(0)).toBe(true)
    expect(isSet(null)).toBe(true)
  })

  test('getFunctionName returns function name', () => {
    function named() {}
    expect(getFunctionName(named)).toBe('named')
    expect(getFunctionName((() => 0) as () => number)).toBe('anonymous')
  })

  test('getFunctionName handles anonymous wrapper', () => {
    const fn = Object.defineProperty(() => 0, 'name', { value: '' })
    expect(getFunctionName(fn)).toBe('anonymous')
  })

  test('taskGroupGather preserves order', async () => {
    const results = await taskGroupGather([() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)])
    expect(results).toEqual([1, 2, 3])
  })

  test('taskGroupGatherConcurrency with null runs all in parallel', async () => {
    const results = await taskGroupGatherConcurrency([() => Promise.resolve('a'), () => Promise.resolve('b')], null)
    expect(results).toEqual(['a', 'b'])
  })

  test('taskGroupGatherConcurrency with limit preserves order', async () => {
    const results = await taskGroupGatherConcurrency(
      [1, 2, 3, 4, 5].map((n) => () => Promise.resolve(n)),
      2
    )
    expect(results).toEqual([1, 2, 3, 4, 5])
  })

  test('taskGroupGatherConcurrency with limit >= length uses parallel', async () => {
    const results = await taskGroupGatherConcurrency([() => Promise.resolve(1), () => Promise.resolve(2)], 5)
    expect(results).toEqual([1, 2])
  })

  test('PydanticEvalsDeprecationWarning holds message', () => {
    const warning = new PydanticEvalsDeprecationWarning('test')
    expect(warning.message).toBe('test')
    expect(warning.name).toBe('PydanticEvalsDeprecationWarning')
  })

  test('warnOnce only emits once', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    warnOnce('test-key-1', 'first')
    warnOnce('test-key-1', 'first again')
    warnOnce('test-key-2', 'second')
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  test('warnOnce falls back to console.warn if emitWarning throws', () => {
    const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {
      throw new Error('nope')
    })
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    warnOnce('test-key-fallback', 'fallback message')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('fallback message'))
    emitSpy.mockRestore()
    consoleSpy.mockRestore()
  })
})
