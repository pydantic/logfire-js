/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { type KSAnalysis, ReportEvaluator, type ReportEvaluatorContext, type ScalarAnalysis } from '../ReportEvaluator'
import { buildThresholdInputs, downsample, type PositiveFrom, type ScoreFrom } from './scoreCommon'

export interface KSOptions {
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

export class KolmogorovSmirnovEvaluator extends ReportEvaluator {
  static evaluatorName = 'KolmogorovSmirnovEvaluator'

  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey?: string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(opts: KSOptions) {
    super()
    this.scoreKey = opts.scoreKey ?? opts.score_key ?? ''
    this.scoreFrom = opts.scoreFrom ?? opts.score_from ?? 'scores'
    this.positiveFrom = opts.positiveFrom ?? opts.positive_from ?? 'expected_output'
    this.positiveKey = opts.positiveKey ?? opts.positive_key
    this.nThresholds = opts.nThresholds ?? opts.n_thresholds ?? 100
    this.title = opts.title ?? 'KS Plot'
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
        title: { default: 'KS Plot', type: 'string' },
      },
      required: ['score_key', 'positive_from'],
      type: 'object',
    }
  }

  evaluate(ctx: ReportEvaluatorContext): [KSAnalysis, ScalarAnalysis] {
    const cases = ctx.report.cases.filter((c): c is ReportCase => 'output' in c)
    const inputs = buildThresholdInputs(cases, {
      positiveFrom: this.positiveFrom,
      positiveKey: this.positiveKey,
      scoreFrom: this.scoreFrom,
      scoreKey: this.scoreKey,
    })

    const positiveScores = inputs.scores.filter((_, i) => inputs.positives[i] === true).sort((a, b) => a - b)
    const negativeScores = inputs.scores.filter((_, i) => inputs.positives[i] === false).sort((a, b) => a - b)
    const allScores = [...new Set(inputs.scores)].sort((a, b) => a - b)

    const emptyResult: [KSAnalysis, ScalarAnalysis] = [
      {
        curves: [],
        title: this.title,
        type: 'line_plot',
        x_label: 'Score',
        y_label: 'Cumulative Probability',
        y_range: [0, 1],
      },
      { title: 'KS Statistic', type: 'scalar', value: Number.NaN },
    ]
    if (allScores.length === 0 || positiveScores.length === 0 || negativeScores.length === 0) return emptyResult

    const cdf = (sorted: readonly number[], x: number): number => {
      if (sorted.length === 0) return 0
      // count of values <= x
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (sorted[mid]! <= x) lo = mid + 1
        else hi = mid
      }
      return lo / sorted.length
    }

    const positivePoints = [{ x: allScores[0]!, y: 0 }, ...allScores.map((x) => ({ x, y: cdf(positiveScores, x) }))]
    const negativePoints = [{ x: allScores[0]!, y: 0 }, ...allScores.map((x) => ({ x, y: cdf(negativeScores, x) }))]

    let ksStatistic = 0
    for (let i = 1; i < positivePoints.length; i++) {
      const diff = Math.abs((positivePoints[i] as { y: number }).y - (negativePoints[i] as { y: number }).y)
      if (diff > ksStatistic) ksStatistic = diff
    }
    const displayPositivePoints = downsample(positivePoints, this.nThresholds)
    const displayNegativePoints = downsample(negativePoints, this.nThresholds)

    return [
      {
        curves: [
          { name: 'Positive', points: displayPositivePoints, step: 'end' },
          { name: 'Negative', points: displayNegativePoints, step: 'end' },
        ],
        title: this.title,
        type: 'line_plot',
        x_label: 'Score',
        y_label: 'Cumulative Probability',
        y_range: [0, 1],
      },
      { title: 'KS Statistic', type: 'scalar', value: ksStatistic },
    ]
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      positive_from: this.positiveFrom,
      score_key: this.scoreKey,
    }
    if (this.positiveKey !== undefined) out.positive_key = this.positiveKey
    if (this.scoreFrom !== 'scores') out.score_from = this.scoreFrom
    if (this.nThresholds !== 100) out.n_thresholds = this.nThresholds
    if (this.title !== 'KS Plot') out.title = this.title
    return out
  }
}
registerReportEvaluator(KolmogorovSmirnovEvaluator)
