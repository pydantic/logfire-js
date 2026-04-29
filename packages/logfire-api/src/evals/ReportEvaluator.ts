import type { ReportCase, ReportCaseFailure } from './reporting'
import type { EvaluatorSpec } from './types'

import { evaluatorRegistryKey } from './registry'

/** Discriminated union of analysis outputs report evaluators may emit. */
export type ReportAnalysis =
  | ConfusionMatrixAnalysis
  | KSAnalysis
  | LinePlotAnalysis
  | PrecisionRecallAnalysis
  | ROCAnalysis
  | ScalarAnalysis
  | TableAnalysis

export interface ConfusionMatrixAnalysis {
  matrix: Record<string, Record<string, number>>
  predicted_labels: string[]
  title: string
  true_labels: string[]
  type: 'confusion_matrix'
}

export interface PrecisionRecallAnalysis {
  precision: number[]
  recall: number[]
  thresholds: number[]
  title: string
  type: 'precision_recall'
}

export interface ROCAnalysis {
  curves: { name: string; points: { x: number; y: number }[]; style?: 'dashed' | 'solid' }[]
  title: string
  type: 'roc_curve'
  x_label: string
  y_label: string
}

export interface KSAnalysis {
  curves: { name: string; points: { x: number; y: number }[] }[]
  title: string
  type: 'ks'
  x_label: string
  y_label: string
}

export interface ScalarAnalysis {
  title: string
  type: 'scalar'
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
  title: string
  type: 'line_plot'
  x_label: string
  y_label: string
}

export interface ReportEvaluatorContext<Inputs = unknown, Output = unknown, Metadata = unknown> {
  cases: readonly (ReportCase<Inputs, Output, Metadata> | ReportCaseFailure<Inputs, Output, Metadata>)[]
  experimentMetadata?: Record<string, unknown>
  name: string
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
