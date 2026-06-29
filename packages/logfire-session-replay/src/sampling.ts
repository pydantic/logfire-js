import type { SamplingMode } from './types'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

export function decideSamplingMode(options: { sessionSampleRate: number; onErrorSampleRate: number; random?: () => number }): SamplingMode {
  const random = options.random ?? Math.random
  if (random() < clamp01(options.sessionSampleRate)) {
    return 'full'
  }
  if (random() < clamp01(options.onErrorSampleRate)) {
    return 'buffer'
  }
  return 'off'
}
