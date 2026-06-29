import { describe, expect, it } from 'vitest'

import { decideSamplingMode } from './sampling'

function rng(values: number[]): () => number {
  let index = 0
  return () => values[index++] ?? 1
}

describe('decideSamplingMode', () => {
  it('records full when the first roll is under the session rate', () => {
    expect(decideSamplingMode({ sessionSampleRate: 1, onErrorSampleRate: 0, random: () => 0 })).toBe('full')
  })

  it('falls back to buffer when over the session rate but under the error rate', () => {
    expect(decideSamplingMode({ sessionSampleRate: 0.5, onErrorSampleRate: 0.5, random: rng([0.9, 0.1]) })).toBe('buffer')
  })

  it('is off when both rolls exceed their rates', () => {
    expect(decideSamplingMode({ sessionSampleRate: 0.5, onErrorSampleRate: 0.5, random: rng([0.9, 0.9]) })).toBe('off')
  })

  it('clamps out-of-range and non-finite rates', () => {
    expect(decideSamplingMode({ sessionSampleRate: 2, onErrorSampleRate: 0, random: () => 0.99 })).toBe('full')
    expect(decideSamplingMode({ sessionSampleRate: Number.NaN, onErrorSampleRate: Number.NaN, random: () => 0 })).toBe('off')
  })
})
