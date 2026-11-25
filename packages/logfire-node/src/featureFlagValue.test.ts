import { describe, expect, it } from 'vite-plus/test'

import { cloneSchemaOutput } from './featureFlagValue'

describe('feature flag schema output', () => {
  it('clones JSON data without interpreting own property names', () => {
    const input = { ['__proto__']: [42, null, 'text', false] }
    const output = cloneSchemaOutput(input)
    expect(output).toEqual(input)
    expect(Object.hasOwn(output, '__proto__')).toBe(true)
    expect(output.__proto__).not.toBe(input.__proto__)
  })

  it.each([undefined, Infinity, NaN, new Date(0), new Set(), { nested: undefined }])('rejects non-JSON output %p', (value) => {
    expect(() => cloneSchemaOutput(value)).toThrow(TypeError)
  })

  it('rejects cycles while allowing repeated object references', () => {
    const cycle: object[] = []
    cycle.push(cycle)
    expect(() => cloneSchemaOutput(cycle)).toThrow(TypeError)
    const shared = { value: 1 }
    expect(cloneSchemaOutput({ left: shared, right: shared })).toEqual({ left: { value: 1 }, right: { value: 1 } })
  })
})
