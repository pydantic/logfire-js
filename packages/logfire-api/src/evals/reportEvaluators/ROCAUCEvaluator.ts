/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { ReportEvaluator, type ReportEvaluatorContext, type ROCAnalysis, type ScalarAnalysis } from '../ReportEvaluator'
import { buildThresholdInputs, type PositiveFrom, type ScoreFrom, trapezoidalAuc, uniqueSortedThresholds } from './scoreCommon'

export interface ROCAUCOptions {
  nThresholds?: number
  positiveFrom: PositiveFrom
  positiveKey?: string
  scoreFrom?: ScoreFrom
  scoreKey: string
  title?: string
}

export class ROCAUCEvaluator extends ReportEvaluator {
  static evaluatorName = 'ROCAUCEvaluator'

  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey?: string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(opts: ROCAUCOptions) {
    super()
    this.scoreKey = opts.scoreKey
    this.scoreFrom = opts.scoreFrom ?? 'scores'
    this.positiveFrom = opts.positiveFrom
    this.positiveKey = opts.positiveKey
    this.nThresholds = opts.nThresholds ?? 100
    this.title = opts.title ?? 'ROC'
  }

  evaluate(ctx: ReportEvaluatorContext): [ROCAnalysis, ScalarAnalysis] {
    const cases = ctx.cases.filter((c): c is ReportCase => 'output' in c)
    const inputs = buildThresholdInputs(cases, {
      positiveFrom: this.positiveFrom,
      positiveKey: this.positiveKey,
      scoreFrom: this.scoreFrom,
      scoreKey: this.scoreKey,
    })

    const thresholds = uniqueSortedThresholds(inputs.scores, this.nThresholds)
    const points: { x: number; y: number }[] = []
    for (const t of thresholds) {
      let tp = 0
      let fp = 0
      let tn = 0
      let fn = 0
      for (let i = 0; i < inputs.scores.length; i++) {
        const positive = inputs.positives[i]!
        const above = inputs.scores[i]! >= t
        if (above && positive) tp++
        else if (above && !positive) fp++
        else if (!above && !positive) tn++
        else fn++
      }
      const fpr = fp + tn === 0 ? 0 : fp / (fp + tn)
      const tpr = tp + fn === 0 ? 0 : tp / (tp + fn)
      points.push({ x: fpr, y: tpr })
    }
    // Sort by FPR ascending so the AUC integral is monotonic
    points.sort((a, b) => a.x - b.x)
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const auc = trapezoidalAuc(xs, ys)

    return [
      {
        curves: [
          { name: 'ROC', points, style: 'solid' },
          {
            name: 'random',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
            style: 'dashed',
          },
        ],
        title: this.title,
        type: 'roc_curve',
        x_label: 'False Positive Rate',
        y_label: 'True Positive Rate',
      },
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
    if (this.title !== 'ROC') out.title = this.title
    return out
  }
}
registerReportEvaluator(ROCAUCEvaluator)
