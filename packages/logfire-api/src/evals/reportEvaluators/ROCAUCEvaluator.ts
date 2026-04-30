/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { ReportEvaluator } from '../ReportEvaluator'
import type { ReportEvaluatorContext, ROCAnalysis, ScalarAnalysis } from '../ReportEvaluator'
import { buildThresholdInputs, downsample, trapezoidalAuc, uniqueSortedThresholds } from './scoreCommon'
import type { PositiveFrom, ScoreFrom } from './scoreCommon'

export interface ROCAUCOptions {
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

export class ROCAUCEvaluator extends ReportEvaluator {
  static override evaluatorName = 'ROCAUCEvaluator'

  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey?: string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(opts: ROCAUCOptions) {
    super()
    this.scoreKey = opts.scoreKey ?? opts.score_key ?? ''
    this.scoreFrom = opts.scoreFrom ?? opts.score_from ?? 'scores'
    this.positiveFrom = opts.positiveFrom ?? opts.positive_from ?? 'expected_output'
    this.positiveKey = opts.positiveKey ?? opts.positive_key
    this.nThresholds = opts.nThresholds ?? opts.n_thresholds ?? 100
    this.title = opts.title ?? 'ROC Curve'
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
        title: { default: 'ROC Curve', type: 'string' },
      },
      required: ['score_key', 'positive_from'],
      type: 'object',
    }
  }

  evaluate(ctx: ReportEvaluatorContext): [ROCAnalysis, ScalarAnalysis] {
    const cases = ctx.report.cases.filter((c): c is ReportCase => 'output' in c)
    const inputs = buildThresholdInputs(cases, {
      positiveFrom: this.positiveFrom,
      positiveKey: this.positiveKey,
      scoreFrom: this.scoreFrom,
      scoreKey: this.scoreKey,
    })

    const emptyResult: [ROCAnalysis, ScalarAnalysis] = [
      {
        curves: [],
        title: this.title,
        type: 'line_plot',
        x_label: 'False Positive Rate',
        x_range: [0, 1],
        y_label: 'True Positive Rate',
        y_range: [0, 1],
      },
      { title: `${this.title} AUC`, type: 'scalar', value: Number.NaN },
    ]
    if (inputs.scores.length === 0) {
      return emptyResult
    }

    const totalPositives = inputs.positives.filter(Boolean).length
    const totalNegatives = inputs.positives.length - totalPositives
    if (totalPositives === 0 || totalNegatives === 0) {
      return emptyResult
    }

    const thresholds = uniqueSortedThresholds(inputs.scores)
    const points: { x: number; y: number }[] = [{ x: 0, y: 0 }]
    for (const t of thresholds) {
      let tp = 0
      let fp = 0
      for (let i = 0; i < inputs.scores.length; i++) {
        const positive = inputs.positives[i]!
        const above = inputs.scores[i]! >= t
        if (above && positive) {
          tp++
        } else if (above && !positive) {
          fp++
        }
      }
      const fpr = fp / totalNegatives
      const tpr = tp / totalPositives
      points.push({ x: fpr, y: tpr })
    }
    // Sort by FPR ascending so the AUC integral is monotonic
    points.sort((a, b) => a.x - b.x)
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const auc = trapezoidalAuc(xs, ys)
    const displayPoints = downsample(points, this.nThresholds)

    return [
      {
        curves: [
          { name: `${ctx.name} (AUC: ${auc.toFixed(3)})`, points: displayPoints, style: 'solid' },
          {
            name: 'Random',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
            style: 'dashed',
          },
        ],
        title: this.title,
        type: 'line_plot',
        x_label: 'False Positive Rate',
        x_range: [0, 1],
        y_label: 'True Positive Rate',
        y_range: [0, 1],
      },
      { title: `${this.title} AUC`, type: 'scalar', value: auc },
    ]
  }

  override toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      positive_from: this.positiveFrom,
      score_key: this.scoreKey,
    }
    if (this.positiveKey !== undefined) {
      out['positive_key'] = this.positiveKey
    }
    if (this.scoreFrom !== 'scores') {
      out['score_from'] = this.scoreFrom
    }
    if (this.nThresholds !== 100) {
      out['n_thresholds'] = this.nThresholds
    }
    if (this.title !== 'ROC Curve') {
      out['title'] = this.title
    }
    return out
  }
}
registerReportEvaluator(ROCAUCEvaluator)
