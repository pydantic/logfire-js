import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { type ConfusionMatrixAnalysis, ReportEvaluator, type ReportEvaluatorContext } from '../ReportEvaluator'

export type ExtractFrom = 'expected_output' | 'labels' | 'metadata' | 'output'

interface ExtractOpts {
  from: ExtractFrom
  key?: string
}

export interface ConfusionMatrixOptions {
  expected?: ExtractOpts
  expected_from?: ExtractFrom
  expected_key?: string
  expectedFrom?: ExtractFrom
  expectedKey?: string
  predicted?: ExtractOpts
  predicted_from?: ExtractFrom
  predicted_key?: string
  predictedFrom?: ExtractFrom
  predictedKey?: string
  title?: string
}

/**
 * Builds a confusion matrix from the report cases. Counts each (expected, predicted)
 * label pair. Mirrors pydantic-evals' `ConfusionMatrixEvaluator`.
 */
export class ConfusionMatrixEvaluator extends ReportEvaluator {
  static evaluatorName = 'ConfusionMatrixEvaluator'

  readonly expected: ExtractOpts
  readonly predicted: ExtractOpts
  readonly title: string

  constructor(opts: ConfusionMatrixOptions = {}) {
    super()
    this.predicted = opts.predicted ?? {
      from: opts.predictedFrom ?? opts.predicted_from ?? 'output',
      key: opts.predictedKey ?? opts.predicted_key,
    }
    this.expected = opts.expected ?? {
      from: opts.expectedFrom ?? opts.expected_from ?? 'expected_output',
      key: opts.expectedKey ?? opts.expected_key,
    }
    this.title = opts.title ?? 'Confusion Matrix'
  }

  static jsonSchema(): Record<string, unknown> {
    const fromSchema = { enum: ['expected_output', 'labels', 'metadata', 'output'] }
    return {
      additionalProperties: false,
      properties: {
        expected_from: { ...fromSchema, default: 'expected_output' },
        expected_key: { type: 'string' },
        predicted_from: { ...fromSchema, default: 'output' },
        predicted_key: { type: 'string' },
        title: { default: 'Confusion Matrix', type: 'string' },
      },
      type: 'object',
    }
  }

  evaluate(ctx: ReportEvaluatorContext): ConfusionMatrixAnalysis {
    const pairs: { expected: string; predicted: string }[] = []
    const labels = new Set<string>()

    for (const c of ctx.report.cases) {
      if (!isReportCase(c)) continue
      const predicted = extractLabel(c, this.predicted)
      const expected = extractLabel(c, this.expected)
      if (predicted === null || expected === null) continue
      pairs.push({ expected, predicted })
      labels.add(expected)
      labels.add(predicted)
    }

    const classLabels = [...labels].sort()
    const index = new Map(classLabels.map((label, i) => [label, i] as const))
    const matrix = classLabels.map(() => classLabels.map(() => 0))
    for (const { expected, predicted } of pairs) {
      const rowIndex = index.get(expected)
      const colIndex = index.get(predicted)
      const row = rowIndex === undefined ? undefined : matrix[rowIndex]
      if (row !== undefined && colIndex !== undefined) {
        row[colIndex] = (row[colIndex] ?? 0) + 1
      }
    }
    return {
      class_labels: classLabels,
      matrix,
      title: this.title,
      type: 'confusion_matrix',
    }
  }

  toJSON(): null | Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (this.predicted.from !== 'output') out.predicted_from = this.predicted.from
    if (this.predicted.key !== undefined) out.predicted_key = this.predicted.key
    if (this.expected.from !== 'expected_output') out.expected_from = this.expected.from
    if (this.expected.key !== undefined) out.expected_key = this.expected.key
    if (this.title !== 'Confusion Matrix') out.title = this.title
    return Object.keys(out).length === 0 ? null : out
  }
}
registerReportEvaluator(ConfusionMatrixEvaluator)

function isReportCase(c: unknown): c is ReportCase {
  return typeof c === 'object' && c !== null && 'output' in c && 'task_duration' in c
}

function extractLabel(c: ReportCase, opts: ExtractOpts): null | string {
  switch (opts.from) {
    case 'expected_output':
      return c.expected_output === undefined ? null : safeStringify(c.expected_output)
    case 'labels': {
      if (opts.key === undefined) throw new Error("'key' is required when from='labels'")
      const r = c.labels[opts.key]
      return r === undefined ? null : String(r.value)
    }
    case 'metadata': {
      if (c.metadata === undefined || c.metadata === null) return null
      if (opts.key === undefined) return safeStringify(c.metadata)
      const v = (c.metadata as Record<string, unknown>)[opts.key]
      return v === undefined || v === null ? null : safeStringify(v)
    }
    case 'output':
      return c.output === null || c.output === undefined ? null : safeStringify(c.output)
  }
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}
