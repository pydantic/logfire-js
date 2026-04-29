/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { type PrecisionRecallAnalysis, ReportEvaluator, type ReportEvaluatorContext, type ScalarAnalysis } from '../ReportEvaluator'
import { buildThresholdInputs, type PositiveFrom, type ScoreFrom, trapezoidalAuc, uniqueSortedThresholds } from './scoreCommon'

export interface PrecisionRecallOptions {
  nThresholds?: number
  positiveFrom: PositiveFrom
  positiveKey?: string
  scoreFrom?: ScoreFrom
  scoreKey: string
  title?: string
}

export class PrecisionRecallEvaluator extends ReportEvaluator {
  static evaluatorName = 'PrecisionRecallEvaluator'

  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey?: string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(opts: PrecisionRecallOptions) {
    super()
    this.scoreKey = opts.scoreKey
    this.scoreFrom = opts.scoreFrom ?? 'scores'
    this.positiveFrom = opts.positiveFrom
    this.positiveKey = opts.positiveKey
    this.nThresholds = opts.nThresholds ?? 100
    this.title = opts.title ?? 'Precision–Recall'
  }

  evaluate(ctx: ReportEvaluatorContext): [PrecisionRecallAnalysis, ScalarAnalysis] {
    const cases = ctx.cases.filter((c): c is ReportCase => 'output' in c)
    const inputs = buildThresholdInputs(cases, {
      positiveFrom: this.positiveFrom,
      positiveKey: this.positiveKey,
      scoreFrom: this.scoreFrom,
      scoreKey: this.scoreKey,
    })

    const thresholds = uniqueSortedThresholds(inputs.scores, this.nThresholds)
    const precision: number[] = []
    const recall: number[] = []
    for (const t of thresholds) {
      let tp = 0
      let fp = 0
      let fn = 0
      for (let i = 0; i < inputs.scores.length; i++) {
        const positive = inputs.positives[i]!
        const aboveThreshold = inputs.scores[i]! >= t
        if (aboveThreshold && positive) tp++
        else if (aboveThreshold && !positive) fp++
        else if (!aboveThreshold && positive) fn++
      }
      precision.push(tp + fp === 0 ? 1 : tp / (tp + fp))
      recall.push(tp + fn === 0 ? 0 : tp / (tp + fn))
    }

    // Recall ascending → AUC under PR curve (a.k.a. average precision).
    const sorted = recall.map((r, i) => [r, precision[i]!] as const).sort((a, b) => a[0] - b[0])
    const xs = sorted.map(([r]) => r)
    const ys = sorted.map(([, p]) => p)
    const auc = trapezoidalAuc(xs, ys)

    return [
      { precision, recall, thresholds, title: this.title, type: 'precision_recall' },
      { title: `${this.title} — AUC`, type: 'scalar', value: auc },
    ]
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      positive_from: this.positiveFrom,
      score_from: this.scoreFrom,
      score_key: this.scoreKey,
    }
    if (this.positiveKey !== undefined) out.positive_key = this.positiveKey
    if (this.nThresholds !== 100) out.n_thresholds = this.nThresholds
    if (this.title !== 'Precision–Recall') out.title = this.title
    return out
  }
}
registerReportEvaluator(PrecisionRecallEvaluator)
