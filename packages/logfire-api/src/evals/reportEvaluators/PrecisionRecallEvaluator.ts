/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { ReportEvaluator } from '../ReportEvaluator'
import type { PrecisionRecallAnalysis, ReportEvaluatorContext, ScalarAnalysis } from '../ReportEvaluator'
import { buildThresholdInputs, downsample, trapezoidalAuc, uniqueSortedThresholds } from './scoreCommon'
import type { PositiveFrom, ScoreFrom } from './scoreCommon'

export interface PrecisionRecallOptions {
  n_thresholds?: number
  nThresholds?: number
  positive_from?: PositiveFrom
  positive_key?: string
  positiveFrom?: PositiveFrom
  positiveKey?: string
  score_from?: ScoreFrom
  score_key?: string
  scoreFrom?: ScoreFrom
  scoreKey?: string
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
    this.scoreKey = opts.scoreKey ?? opts.score_key ?? ''
    this.scoreFrom = opts.scoreFrom ?? opts.score_from ?? 'scores'
    this.positiveFrom = opts.positiveFrom ?? opts.positive_from ?? 'expected_output'
    this.positiveKey = opts.positiveKey ?? opts.positive_key
    this.nThresholds = opts.nThresholds ?? opts.n_thresholds ?? 100
    this.title = opts.title ?? 'Precision-Recall Curve'
  }

  static jsonSchema(): Record<string, unknown> {
    return {
      additionalProperties: false,
      properties: {
        n_thresholds: { default: 100, type: 'integer' },
        positive_from: { enum: ['assertions', 'expected_output', 'labels'] },
        positive_key: { type: 'string' },
        score_from: { default: 'scores', enum: ['metrics', 'scores'] },
        score_key: { type: 'string' },
        title: { default: 'Precision-Recall Curve', type: 'string' },
      },
      required: ['score_key', 'positive_from'],
      type: 'object',
    }
  }

  evaluate(ctx: ReportEvaluatorContext): [PrecisionRecallAnalysis, ScalarAnalysis] {
    const cases = ctx.report.cases.filter((c): c is ReportCase => 'output' in c)
    const inputs = buildThresholdInputs(cases, {
      positiveFrom: this.positiveFrom,
      positiveKey: this.positiveKey,
      scoreFrom: this.scoreFrom,
      scoreKey: this.scoreKey,
    })

    const thresholds = uniqueSortedThresholds(inputs.scores)
    const points: { precision: number; recall: number; threshold: number }[] = []
    if (inputs.scores.length > 0) {
      points.push({ precision: 1, recall: 0, threshold: Math.max(...inputs.scores) })
    }
    for (const t of thresholds) {
      let tp = 0
      let fp = 0
      let fn = 0
      for (let i = 0; i < inputs.scores.length; i++) {
        const positive = inputs.positives[i]!
        const aboveThreshold = inputs.scores[i]! >= t
        if (aboveThreshold && positive) {
          tp++
        } else if (aboveThreshold && !positive) {
          fp++
        } else if (!aboveThreshold && positive) {
          fn++
        }
      }
      points.push({
        precision: tp + fp === 0 ? 1 : tp / (tp + fp),
        recall: tp + fn === 0 ? 0 : tp / (tp + fn),
        threshold: t,
      })
    }

    // Recall ascending → AUC under PR curve (a.k.a. average precision).
    const xs = points.map((p) => p.recall)
    const ys = points.map((p) => p.precision)
    const auc = inputs.scores.length === 0 ? Number.NaN : trapezoidalAuc(xs, ys)
    const displayPoints = downsample(points, this.nThresholds)

    return [
      {
        curves: inputs.scores.length === 0 ? [] : [{ auc, name: ctx.name, points: displayPoints }],
        title: this.title,
        type: 'precision_recall',
      },
      { title: `${this.title} AUC`, type: 'scalar', value: auc },
    ]
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      positive_from: this.positiveFrom,
      score_key: this.scoreKey,
    }
    if (this.positiveKey !== undefined) {
      out.positive_key = this.positiveKey
    }
    if (this.scoreFrom !== 'scores') {
      out.score_from = this.scoreFrom
    }
    if (this.nThresholds !== 100) {
      out.n_thresholds = this.nThresholds
    }
    if (this.title !== 'Precision-Recall Curve') {
      out.title = this.title
    }
    return out
  }
}
registerReportEvaluator(PrecisionRecallEvaluator)
