/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { type KSAnalysis, ReportEvaluator, type ReportEvaluatorContext, type ScalarAnalysis } from '../ReportEvaluator'
import { buildThresholdInputs, type PositiveFrom, type ScoreFrom } from './scoreCommon'

export interface KSOptions {
  positiveFrom: PositiveFrom
  positiveKey?: string
  scoreFrom?: ScoreFrom
  scoreKey: string
  title?: string
}

export class KolmogorovSmirnovEvaluator extends ReportEvaluator {
  static evaluatorName = 'KolmogorovSmirnovEvaluator'

  readonly positiveFrom: PositiveFrom
  readonly positiveKey?: string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(opts: KSOptions) {
    super()
    this.scoreKey = opts.scoreKey
    this.scoreFrom = opts.scoreFrom ?? 'scores'
    this.positiveFrom = opts.positiveFrom
    this.positiveKey = opts.positiveKey
    this.title = opts.title ?? 'Kolmogorov–Smirnov'
  }

  evaluate(ctx: ReportEvaluatorContext): [KSAnalysis, ScalarAnalysis] {
    const cases = ctx.cases.filter((c): c is ReportCase => 'output' in c)
    const inputs = buildThresholdInputs(cases, {
      positiveFrom: this.positiveFrom,
      positiveKey: this.positiveKey,
      scoreFrom: this.scoreFrom,
      scoreKey: this.scoreKey,
    })

    const positiveScores = inputs.scores.filter((_, i) => inputs.positives[i] === true).sort((a, b) => a - b)
    const negativeScores = inputs.scores.filter((_, i) => inputs.positives[i] === false).sort((a, b) => a - b)
    const allScores = [...inputs.scores].sort((a, b) => a - b)

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

    const positivePoints = allScores.map((x) => ({ x, y: cdf(positiveScores, x) }))
    const negativePoints = allScores.map((x) => ({ x, y: cdf(negativeScores, x) }))

    let ksStatistic = 0
    for (let i = 0; i < allScores.length; i++) {
      const diff = Math.abs((positivePoints[i] as { y: number }).y - (negativePoints[i] as { y: number }).y)
      if (diff > ksStatistic) ksStatistic = diff
    }

    return [
      {
        curves: [
          { name: 'positive CDF', points: positivePoints },
          { name: 'negative CDF', points: negativePoints },
        ],
        title: this.title,
        type: 'ks',
        x_label: 'score',
        y_label: 'CDF',
      },
      { title: `${this.title} — KS statistic`, type: 'scalar', value: ksStatistic },
    ]
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      positive_from: this.positiveFrom,
      score_from: this.scoreFrom,
      score_key: this.scoreKey,
    }
    if (this.positiveKey !== undefined) out.positive_key = this.positiveKey
    if (this.title !== 'Kolmogorov–Smirnov') out.title = this.title
    return out
  }
}
registerReportEvaluator(KolmogorovSmirnovEvaluator)
