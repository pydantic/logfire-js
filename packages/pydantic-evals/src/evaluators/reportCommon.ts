import type { ConfusionMatrix, LinePlotCurve, PrecisionRecallCurve, PrecisionRecallPoint, ReportAnalysis } from '../reporting/analyses'

import { ReportEvaluator, ReportEvaluatorContext } from './reportEvaluator'

type Case = ReportEvaluatorContext['report']['cases'][number]
type ScoreFrom = 'metrics' | 'scores'
type PositiveFrom = 'assertions' | 'expected_output' | 'labels'

function getScore(caseObj: Case, scoreKey: string, scoreFrom: ScoreFrom): null | number {
  if (scoreFrom === 'scores') {
    const r = caseObj.scores[scoreKey]
    return r !== undefined ? Number(r.value) : null
  }
  const v = caseObj.metrics[scoreKey]
  return v !== undefined ? Number(v) : null
}

function getPositive(caseObj: Case, positiveFrom: PositiveFrom, positiveKey: null | string): boolean | null {
  if (positiveFrom === 'expected_output') {
    return caseObj.expectedOutput === null || caseObj.expectedOutput === undefined ? null : Boolean(caseObj.expectedOutput)
  }
  if (positiveFrom === 'assertions') {
    if (positiveKey === null) throw new Error("'positiveKey' is required when positiveFrom='assertions'")
    const a = caseObj.assertions[positiveKey]
    return a !== undefined ? a.value : null
  }
  if (positiveFrom === 'labels') {
    if (positiveKey === null) throw new Error("'positiveKey' is required when positiveFrom='labels'")
    const l = caseObj.labels[positiveKey]
    return l !== undefined ? Boolean(l.value) : null
  }
  return null
}

function extractScoredCases(
  cases: Case[],
  scoreKey: string,
  scoreFrom: ScoreFrom,
  positiveFrom: PositiveFrom,
  positiveKey: null | string
): [number, boolean][] {
  const out: [number, boolean][] = []
  for (const c of cases) {
    const s = getScore(c, scoreKey, scoreFrom)
    const p = getPositive(c, positiveFrom, positiveKey)
    if (s === null || p === null) continue
    out.push([s, p])
  }
  return out
}

function downsample<T>(points: T[], n: number): T[] {
  if (points.length <= n || n <= 1) return points
  const indices = Array.from(new Set(Array.from({ length: n }, (_, i) => Math.floor((i * (points.length - 1)) / (n - 1))))).sort(
    (a, b) => a - b
  )
  return indices.map((i) => points[i]!)
}

function trapezoidalAUC(points: [number, number][]): number {
  let auc = 0
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!
    const [x2, y2] = points[i]!
    auc += Math.abs(x2 - x1) * ((y1 + y2) / 2)
  }
  return auc
}

function bisectRight(arr: number[], value: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface ConfusionMatrixEvaluatorOptions {
  expectedFrom?: 'expected_output' | 'labels' | 'metadata' | 'output'
  expectedKey?: null | string
  predictedFrom?: 'expected_output' | 'labels' | 'metadata' | 'output'
  predictedKey?: null | string
  title?: string
}

export class ConfusionMatrixEvaluator extends ReportEvaluator {
  readonly expectedFrom: 'expected_output' | 'labels' | 'metadata' | 'output'
  readonly expectedKey: null | string
  readonly predictedFrom: 'expected_output' | 'labels' | 'metadata' | 'output'
  readonly predictedKey: null | string
  readonly title: string

  constructor(params: ConfusionMatrixEvaluatorOptions = {}) {
    super()
    this.predictedFrom = params.predictedFrom ?? 'output'
    this.predictedKey = params.predictedKey ?? null
    this.expectedFrom = params.expectedFrom ?? 'expected_output'
    this.expectedKey = params.expectedKey ?? null
    this.title = params.title ?? 'Confusion Matrix'
  }

  evaluate(ctx: ReportEvaluatorContext): ConfusionMatrix {
    const predicted: string[] = []
    const expected: string[] = []
    for (const c of ctx.report.cases) {
      const p = this.extract(c, this.predictedFrom, this.predictedKey)
      const e = this.extract(c, this.expectedFrom, this.expectedKey)
      if (p === null || e === null) continue
      predicted.push(p)
      expected.push(e)
    }
    const allLabels = Array.from(new Set([...expected, ...predicted])).sort()
    const labelToIdx = new Map(allLabels.map((l, i) => [l, i]))
    const matrix: number[][] = allLabels.map(() => new Array<number>(allLabels.length).fill(0))
    for (let i = 0; i < predicted.length; i++) {
      const ei = labelToIdx.get(expected[i]!)!
      const pi = labelToIdx.get(predicted[i]!)!
      matrix[ei]![pi]! += 1
    }
    return { classLabels: allLabels, matrix, title: this.title, type: 'confusion_matrix' }
  }

  private extract(c: Case, from: 'expected_output' | 'labels' | 'metadata' | 'output', key: null | string): null | string {
    if (from === 'expected_output') return c.expectedOutput === null || c.expectedOutput === undefined ? null : String(c.expectedOutput)
    if (from === 'output') return c.output === null || c.output === undefined ? null : String(c.output)
    if (from === 'metadata') {
      if (key !== null) {
        if (c.metadata !== null && typeof c.metadata === 'object') {
          const v = (c.metadata as Record<string, unknown>)[key]
          return v === undefined || v === null ? null : String(v)
        }
        return null
      }
      return c.metadata === null || c.metadata === undefined ? null : String(c.metadata)
    }
    if (from === 'labels') {
      if (key === null) throw new Error("'key' is required when from='labels'")
      const l = c.labels[key]
      return l !== undefined ? l.value : null
    }
    return null
  }
}

export interface PrecisionRecallEvaluatorOptions {
  nThresholds?: number
  positiveFrom: PositiveFrom
  positiveKey?: null | string
  scoreFrom?: ScoreFrom
  scoreKey: string
  title?: string
}

export class PrecisionRecallEvaluator extends ReportEvaluator {
  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey: null | string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(params: PrecisionRecallEvaluatorOptions) {
    super()
    this.scoreKey = params.scoreKey
    this.positiveFrom = params.positiveFrom
    this.positiveKey = params.positiveKey ?? null
    this.scoreFrom = params.scoreFrom ?? 'scores'
    this.title = params.title ?? 'Precision-Recall Curve'
    this.nThresholds = params.nThresholds ?? 100
  }

  evaluate(ctx: ReportEvaluatorContext): ReportAnalysis[] {
    const scoredCases = extractScoredCases(ctx.report.cases, this.scoreKey, this.scoreFrom, this.positiveFrom, this.positiveKey)
    if (scoredCases.length === 0) {
      return [
        { curves: [], title: this.title, type: 'precision_recall' },
        { title: `${this.title} AUC`, type: 'scalar', value: Number.NaN },
      ]
    }
    const totalPositives = scoredCases.filter(([, p]) => p).length
    const uniqueThresholds = Array.from(new Set(scoredCases.map(([s]) => s))).sort((a, b) => b - a)
    const maxScore = uniqueThresholds[0]!
    const allPoints: PrecisionRecallPoint[] = [{ precision: 1.0, recall: 0.0, threshold: maxScore }]
    for (const threshold of uniqueThresholds) {
      const tp = scoredCases.filter(([s, p]) => s >= threshold && p).length
      const fp = scoredCases.filter(([s, p]) => s >= threshold && !p).length
      const fn = totalPositives - tp
      const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0
      const recall = fn + tp > 0 ? tp / (fn + tp) : 0.0
      allPoints.push({ precision, recall, threshold })
    }
    const aucPoints: [number, number][] = allPoints.map((p) => [p.recall, p.precision])
    const auc = trapezoidalAUC(aucPoints)
    const displayPoints =
      allPoints.length <= this.nThresholds || this.nThresholds <= 1 ? allPoints : downsample(allPoints, this.nThresholds)
    const curve: PrecisionRecallCurve = { auc, name: ctx.name, points: displayPoints }
    return [
      { curves: [curve], title: this.title, type: 'precision_recall' },
      { title: `${this.title} AUC`, type: 'scalar', value: auc },
    ]
  }
}

export interface ROCAUCEvaluatorOptions {
  nThresholds?: number
  positiveFrom: PositiveFrom
  positiveKey?: null | string
  scoreFrom?: ScoreFrom
  scoreKey: string
  title?: string
}

export class ROCAUCEvaluator extends ReportEvaluator {
  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey: null | string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(params: ROCAUCEvaluatorOptions) {
    super()
    this.scoreKey = params.scoreKey
    this.positiveFrom = params.positiveFrom
    this.positiveKey = params.positiveKey ?? null
    this.scoreFrom = params.scoreFrom ?? 'scores'
    this.title = params.title ?? 'ROC Curve'
    this.nThresholds = params.nThresholds ?? 100
  }

  evaluate(ctx: ReportEvaluatorContext): ReportAnalysis[] {
    const emptyResult: ReportAnalysis[] = [
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
    const scoredCases = extractScoredCases(ctx.report.cases, this.scoreKey, this.scoreFrom, this.positiveFrom, this.positiveKey)
    if (scoredCases.length === 0) return emptyResult
    const totalPositives = scoredCases.filter(([, p]) => p).length
    const totalNegatives = scoredCases.length - totalPositives
    if (totalPositives === 0 || totalNegatives === 0) return emptyResult

    const uniqueThresholds = Array.from(new Set(scoredCases.map(([s]) => s))).sort((a, b) => b - a)
    const allFprTpr: [number, number][] = [[0, 0]]
    for (const threshold of uniqueThresholds) {
      const tp = scoredCases.filter(([s, p]) => s >= threshold && p).length
      const fp = scoredCases.filter(([s, p]) => s >= threshold && !p).length
      allFprTpr.push([fp / totalNegatives, tp / totalPositives])
    }
    allFprTpr.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const auc = trapezoidalAUC(allFprTpr)
    const downsampled = downsample(allFprTpr, this.nThresholds)
    const rocCurve: LinePlotCurve = {
      name: `${ctx.name} (AUC: ${auc.toFixed(3)})`,
      points: downsampled.map(([fpr, tpr]) => ({ x: fpr, y: tpr })),
    }
    const baseline: LinePlotCurve = {
      name: 'Random',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      style: 'dashed',
    }
    return [
      {
        curves: [rocCurve, baseline],
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
}

export interface KSEvaluatorOptions {
  nThresholds?: number
  positiveFrom: PositiveFrom
  positiveKey?: null | string
  scoreFrom?: ScoreFrom
  scoreKey: string
  title?: string
}

export class KolmogorovSmirnovEvaluator extends ReportEvaluator {
  readonly nThresholds: number
  readonly positiveFrom: PositiveFrom
  readonly positiveKey: null | string
  readonly scoreFrom: ScoreFrom
  readonly scoreKey: string
  readonly title: string

  constructor(params: KSEvaluatorOptions) {
    super()
    this.scoreKey = params.scoreKey
    this.positiveFrom = params.positiveFrom
    this.positiveKey = params.positiveKey ?? null
    this.scoreFrom = params.scoreFrom ?? 'scores'
    this.title = params.title ?? 'KS Plot'
    this.nThresholds = params.nThresholds ?? 100
  }

  evaluate(ctx: ReportEvaluatorContext): ReportAnalysis[] {
    const emptyResult: ReportAnalysis[] = [
      { curves: [], title: this.title, type: 'line_plot', x_label: 'Score', y_label: 'Cumulative Probability', y_range: [0, 1] },
      { title: 'KS Statistic', type: 'scalar', value: Number.NaN },
    ]
    const scoredCases = extractScoredCases(ctx.report.cases, this.scoreKey, this.scoreFrom, this.positiveFrom, this.positiveKey)
    if (scoredCases.length === 0) return emptyResult
    const posScores = scoredCases
      .filter(([, p]) => p)
      .map(([s]) => s)
      .sort((a, b) => a - b)
    const negScores = scoredCases
      .filter(([, p]) => !p)
      .map(([s]) => s)
      .sort((a, b) => a - b)
    if (posScores.length === 0 || negScores.length === 0) return emptyResult
    const allScores = Array.from(new Set(scoredCases.map(([s]) => s))).sort((a, b) => a - b)
    const posCdf: [number, number][] = [[allScores[0]!, 0]]
    const negCdf: [number, number][] = [[allScores[0]!, 0]]
    let ksStat = 0
    for (const score of allScores) {
      const posVal = bisectRight(posScores, score) / posScores.length
      const negVal = bisectRight(negScores, score) / negScores.length
      posCdf.push([score, posVal])
      negCdf.push([score, negVal])
      ksStat = Math.max(ksStat, Math.abs(posVal - negVal))
    }
    const displayPos = downsample(posCdf, this.nThresholds)
    const displayNeg = downsample(negCdf, this.nThresholds)
    return [
      {
        curves: [
          { name: 'Positive', points: displayPos.map(([x, y]) => ({ x, y })), step: 'end' },
          { name: 'Negative', points: displayNeg.map(([x, y]) => ({ x, y })), step: 'end' },
        ],
        title: this.title,
        type: 'line_plot',
        x_label: 'Score',
        y_label: 'Cumulative Probability',
        y_range: [0, 1],
      },
      { title: 'KS Statistic', type: 'scalar', value: ksStat },
    ]
  }
}

export const DEFAULT_REPORT_EVALUATORS = [
  ConfusionMatrixEvaluator,
  KolmogorovSmirnovEvaluator,
  PrecisionRecallEvaluator,
  ROCAUCEvaluator,
] as const
