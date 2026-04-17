export interface ConfusionMatrix {
  classLabels: string[]
  description?: null | string
  matrix: number[][]
  title: string
  type: 'confusion_matrix'
}

export interface PrecisionRecallPoint {
  precision: number
  recall: number
  threshold: number
}

export interface PrecisionRecallCurve {
  auc?: null | number
  name: string
  points: PrecisionRecallPoint[]
}

export interface PrecisionRecall {
  curves: PrecisionRecallCurve[]
  description?: null | string
  title: string
  type: 'precision_recall'
}

export interface ScalarResult {
  description?: null | string
  title: string
  type: 'scalar'
  unit?: null | string
  value: number
}

export interface TableResult {
  columns: string[]
  description?: null | string
  rows: (boolean | null | number | string)[][]
  title: string
  type: 'table'
}

export interface LinePlotPoint {
  x: number
  y: number
}

export interface LinePlotCurve {
  name: string
  points: LinePlotPoint[]
  step?: 'end' | 'middle' | 'start' | null
  style?: 'dashed' | 'solid'
}

export interface LinePlot {
  curves: LinePlotCurve[]
  description?: null | string
  title: string
  type: 'line_plot'
  x_label: string
  x_range?: [number, number] | null
  y_label: string
  y_range?: [number, number] | null
}

export type ReportAnalysis = ConfusionMatrix | LinePlot | PrecisionRecall | ScalarResult | TableResult
