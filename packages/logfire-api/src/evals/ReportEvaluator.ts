import type { EvaluationReport, ReportCase, ReportCaseFailure } from './reporting'
import type { EvaluatorSpec } from './types'

import { evaluatorRegistryKey } from './registry'

/** Discriminated union of analysis outputs report evaluators may emit. */
export type ReportAnalysis = ConfusionMatrixAnalysis | LinePlotAnalysis | PrecisionRecallAnalysis | ScalarAnalysis | TableAnalysis

export interface ConfusionMatrixAnalysis {
  class_labels: string[]
  description?: string
  matrix: number[][]
  title: string
  type: 'confusion_matrix'
}

export interface PrecisionRecallAnalysis {
  curves: { auc?: number; name: string; points: { precision: number; recall: number; threshold: number }[] }[]
  description?: string
  title: string
  type: 'precision_recall'
}

export type ROCAnalysis = LinePlotAnalysis
export type KSAnalysis = LinePlotAnalysis

export interface ScalarAnalysis {
  description?: string
  title: string
  type: 'scalar'
  unit?: string
  value: number
}

export interface TableAnalysis {
  columns: string[]
  rows: (number | string)[][]
  title: string
  type: 'table'
}

export interface LinePlotAnalysis {
  curves: { name: string; points: { x: number; y: number }[]; step?: 'end' | 'middle' | 'start'; style?: 'dashed' | 'solid' }[]
  description?: string
  title: string
  type: 'line_plot'
  x_label: string
  x_range?: [number, number]
  y_label: string
  y_range?: [number, number]
}

export interface ReportEvaluatorContext<Inputs = unknown, Output = unknown, Metadata = unknown> {
  cases: readonly (ReportCase<Inputs, Output, Metadata> | ReportCaseFailure<Inputs, Output, Metadata>)[]
  experimentMetadata?: Record<string, unknown>
  name: string
  report: EvaluationReport<Inputs, Output, Metadata>
}

export abstract class ReportEvaluator<Inputs = unknown, Output = unknown, Metadata = unknown> {
  static evaluatorName?: string

  evaluatorVersion?: string

  abstract evaluate(
    ctx: ReportEvaluatorContext<Inputs, Output, Metadata>
  ): Promise<ReportAnalysis | ReportAnalysis[]> | ReportAnalysis | ReportAnalysis[]

  getSpec(): EvaluatorSpec {
    const cls = this.constructor as { evaluatorName?: string; name: string }
    return {
      arguments: this.toJSON(),
      name: evaluatorRegistryKey(cls),
    }
  }

  toJSON(): null | Record<string, unknown> | unknown[] {
    return null
  }
}
