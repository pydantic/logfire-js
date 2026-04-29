/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Shared helpers for the threshold-sweeping report evaluators
 * (PrecisionRecall, ROCAUC, KS).
 */

import type { ReportCase } from '../reporting'

export type ScoreFrom = 'metrics' | 'scores'
export type PositiveFrom = 'assertions' | 'expected_output' | 'labels'

export interface ThresholdInputs {
  /** Boolean ground truth per case. */
  positives: boolean[]
  /** Numeric "score" per case, used as the variable threshold. */
  scores: number[]
}

export interface ThresholdOptions {
  positiveFrom: PositiveFrom
  positiveKey?: string
  scoreFrom: ScoreFrom
  scoreKey: string
}

/** Build per-case (score, positive) pairs from a list of report cases. Skips cases where either is missing. */
export function buildThresholdInputs(cases: readonly ReportCase[], opts: ThresholdOptions): ThresholdInputs {
  const out: ThresholdInputs = { positives: [], scores: [] }
  for (const c of cases) {
    const score = extractScore(c, opts)
    const positive = extractPositive(c, opts)
    if (score === null || positive === null) continue
    out.scores.push(score)
    out.positives.push(positive)
  }
  return out
}

function extractScore(c: ReportCase, opts: ThresholdOptions): null | number {
  if (opts.scoreFrom === 'scores') {
    const r = c.scores[opts.scoreKey]
    return typeof r?.value === 'number' ? r.value : null
  }
  const v = c.metrics[opts.scoreKey]
  return typeof v === 'number' ? v : null
}

function extractPositive(c: ReportCase, opts: ThresholdOptions): boolean | null {
  switch (opts.positiveFrom) {
    case 'assertions': {
      if (opts.positiveKey === undefined) return null
      const r = c.assertions[opts.positiveKey]
      return typeof r?.value === 'boolean' ? r.value : null
    }
    case 'expected_output': {
      if (opts.positiveKey === undefined) return Boolean(c.expected_output)
      if (c.expected_output === null || c.expected_output === undefined) return null
      const v = (c.expected_output as Record<string, unknown>)[opts.positiveKey]
      return typeof v === 'boolean' ? v : v === undefined ? null : Boolean(v)
    }
    case 'labels': {
      if (opts.positiveKey === undefined) return null
      const r = c.labels[opts.positiveKey]
      return r === undefined ? null : Boolean(r.value)
    }
  }
}

export function uniqueSortedThresholds(scores: readonly number[], n: number): number[] {
  if (scores.length === 0) return []
  let lo = Infinity
  let hi = -Infinity
  for (const s of scores) {
    if (s < lo) lo = s
    if (s > hi) hi = s
  }
  if (lo === hi) return [lo]
  const step = (hi - lo) / (n - 1)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(lo + step * i)
  return out
}

/** AUC via the trapezoidal rule. Expects `xs` already sorted ascending. */
export function trapezoidalAuc(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 2) return 0
  let auc = 0
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!
    const yMid = (ys[i]! + ys[i - 1]!) / 2
    auc += dx * yMid
  }
  return auc
}
