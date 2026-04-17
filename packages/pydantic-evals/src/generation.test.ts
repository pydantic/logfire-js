import { describe, expect, test } from 'vitest'

import { generateDataset } from './generation'

describe('generateDataset', () => {
  test('creates a dataset from generator output', async () => {
    const ds = await generateDataset<string, string>({
      generator: async ({ nExamples }) =>
        await Promise.resolve({
          cases: Array.from({ length: nExamples }, (_, i) => ({
            expectedOutput: `out${String(i)}`,
            inputs: `in${String(i)}`,
            name: `c${String(i)}`,
          })),
        }),
      nExamples: 2,
    })
    expect(ds.name).toBe('generated')
    expect(ds.cases).toHaveLength(2)
    expect(ds.cases[0]?.inputs).toBe('in0')
  })

  test('uses default name when not provided', async () => {
    const ds = await generateDataset({
      generator: () => Promise.resolve({ cases: [{ inputs: 1 }] }),
    })
    expect(ds.name).toBe('generated')
    expect(ds.cases).toHaveLength(1)
  })

  test('respects provided name', async () => {
    const ds = await generateDataset({
      generator: () => Promise.resolve({ cases: [{ inputs: 1 }] }),
      name: 'custom',
    })
    expect(ds.name).toBe('custom')
  })
})
