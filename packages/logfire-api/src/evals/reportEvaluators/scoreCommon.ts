/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Shared helpers for the threshold-sweeping report evaluators
 * (PrecisionRecall, ROCAUC, KS).
 */

import type { ReportCase } from '../reporting'

import { getOwn } from '../../ownRecord'

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
  validateThresholdOptions(opts)
  const out: ThresholdInputs = { positives: [], scores: [] }
  for (const c of cases) {
    const score = extractScore(c, opts)
    const positive = extractPositive(c, opts)
    if (score === null || positive === null) {
      continue
    }
    out.scores.push(score)
    out.positives.push(positive)
  }
  return out
}

// The score and positive keys are the user's own naming, so every lookup below reads an own
// property. A bare index read finds the inherited member for a key like `toString`, and the
// `labels` branch is the one where that mattered: it is the only branch that does not also
// type-check the value, so an absent label resolved to the inherited function and `Boolean(undefined)`
// scored the case as a ground-truth negative instead of skipping it.
function extractScore(c: ReportCase, opts: ThresholdOptions): null | number {
  if (opts.scoreFrom === 'scores') {
    const r = getOwn(c.scores, opts.scoreKey)
    return typeof r?.value === 'number' ? r.value : null
  }
  const v = getOwn(c.metrics, opts.scoreKey)
  return typeof v === 'number' ? v : null
}

function extractPositive(c: ReportCase, opts: ThresholdOptions): boolean | null {
  switch (opts.positiveFrom) {
    case 'assertions': {
      const r = getOwn(c.assertions, opts.positiveKey!)
      return typeof r?.value === 'boolean' ? r.value : null
    }
    case 'expected_output': {
      return c.expected_output === undefined || c.expected_output === null ? null : Boolean(c.expected_output)
    }
    case 'labels': {
      const r = getOwn(c.labels, opts.positiveKey!)
      return r === undefined ? null : Boolean(r.value)
    }
    default:
      return null
  }
}

function validateThresholdOptions(opts: ThresholdOptions): void {
  if (opts.positiveFrom === 'expected_output') {
    if (opts.positiveKey !== undefined) {
      throw new Error("'positiveKey' is not supported when positiveFrom='expected_output'")
    }
    return
  }
  if (opts.positiveKey === undefined) {
    throw new Error(`'positiveKey' is required when positiveFrom='${opts.positiveFrom}'`)
  }
}

export function uniqueSortedThresholds(scores: readonly number[], n: number = Number.POSITIVE_INFINITY): number[] {
  if (scores.length === 0) {
    return []
  }
  const unique = [...new Set(scores)].sort((a, b) => b - a)
  return downsample(unique, n)
}

/** AUC via the trapezoidal rule. Expects `xs` already sorted ascending. */
export function trapezoidalAuc(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 2) {
    return 0
  }
  let auc = 0
  for (let i = 1; i < xs.length; i++) {
    const dx = Math.abs(xs[i]! - xs[i - 1]!)
    const yMid = (ys[i]! + ys[i - 1]!) / 2
    auc += dx * yMid
  }
  return auc
}

export function downsample<T>(items: readonly T[], maxItems: number): T[] {
  if (items.length <= maxItems || maxItems <= 1) {
    return [...items]
  }
  const indices = new Set<number>()
  for (let i = 0; i < maxItems; i++) {
    indices.add(Math.floor((i * (items.length - 1)) / (maxItems - 1)))
  }
  return [...indices].sort((a, b) => a - b).map((i) => items[i]!)
}
