import type { ReportCase } from '../reporting'

import { registerReportEvaluator } from '../registry'
import { type ConfusionMatrixAnalysis, ReportEvaluator, type ReportEvaluatorContext } from '../ReportEvaluator'

export type ExtractFrom = 'expected_output' | 'labels' | 'metadata' | 'output'

interface ExtractOpts {
  from: ExtractFrom
  key?: string
}

export interface ConfusionMatrixOptions {
  expected: ExtractOpts
  predicted: ExtractOpts
  title?: string
}

/**
 * Builds a confusion matrix from the report cases. Counts each (predicted, expected)
 * label pair. Mirrors pydantic-evals' `ConfusionMatrixEvaluator`.
 */
export class ConfusionMatrixEvaluator extends ReportEvaluator {
  static evaluatorName = 'ConfusionMatrixEvaluator'

  readonly expected: ExtractOpts
  readonly predicted: ExtractOpts
  readonly title: string

  constructor(opts: ConfusionMatrixOptions) {
    super()
    this.predicted = opts.predicted
    this.expected = opts.expected
    this.title = opts.title ?? 'Confusion Matrix'
  }

  evaluate(ctx: ReportEvaluatorContext): ConfusionMatrixAnalysis {
    const matrix: Record<string, Record<string, number>> = {}
    const trueLabels = new Set<string>()
    const predictedLabels = new Set<string>()

    for (const c of ctx.cases) {
      if (!isReportCase(c)) continue
      const p = extractLabel(c, this.predicted)
      const e = extractLabel(c, this.expected)
      if (p === null || e === null) continue
      predictedLabels.add(p)
      trueLabels.add(e)
      const row = (matrix[p] ??= {})
      row[e] = (row[e] ?? 0) + 1
    }

    return {
      matrix,
      predicted_labels: [...predictedLabels].sort(),
      title: this.title,
      true_labels: [...trueLabels].sort(),
      type: 'confusion_matrix',
    }
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      expected: this.expected,
      predicted: this.predicted,
    }
    if (this.title !== 'Confusion Matrix') out.title = this.title
    return out
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
      if (opts.key === undefined) return null
      const r = c.labels[opts.key]
      return r === undefined ? null : String(r.value)
    }
    case 'metadata': {
      if (c.metadata === undefined || c.metadata === null) return null
      if (opts.key === undefined) return null
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
