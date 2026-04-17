import { EvaluationResult, EvaluatorFailure } from '../evaluators/evaluator'
import { ReportAnalysis } from './analyses'
import {
  defaultRenderDuration,
  defaultRenderDurationDiff,
  defaultRenderNumber,
  defaultRenderNumberDiff,
  defaultRenderPercentage,
} from './renderNumbers'

export interface ReportCase<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  assertions: Record<string, EvaluationResult<boolean>>
  attributes: Record<string, unknown>
  evaluatorFailures: EvaluatorFailure[]
  expectedOutput: null | OutputT
  inputs: InputsT
  labels: Record<string, EvaluationResult<string>>
  metadata: MetadataT | null
  metrics: Record<string, number>
  name: string
  output: OutputT
  scores: Record<string, EvaluationResult<number>>
  sourceCaseName: null | string
  spanId: null | string
  taskDuration: number
  totalDuration: number
  traceId: null | string
}

export interface ReportCaseFailure<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  errorMessage: string
  errorStacktrace: string
  expectedOutput: null | OutputT
  inputs: InputsT
  metadata: MetadataT | null
  name: string
  sourceCaseName: null | string
  spanId: null | string
  traceId: null | string
}

export interface ReportCaseAggregate {
  assertions: null | number
  labels: Record<string, Record<string, number>>
  metrics: Record<string, number>
  name: string
  scores: Record<string, number>
  taskDuration: number
  totalDuration: number
}

export interface ReportCaseGroup<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  expectedOutput: null | OutputT
  failures: ReportCaseFailure<InputsT, OutputT, MetadataT>[]
  inputs: InputsT
  metadata: MetadataT | null
  name: string
  runs: ReportCase<InputsT, OutputT, MetadataT>[]
  summary: ReportCaseAggregate
}

function averageScores(scoresByName: Record<string, number>[]): Record<string, number> {
  const counts: Record<string, number> = {}
  const sums: Record<string, number> = {}
  for (const sbn of scoresByName) {
    for (const [name, v] of Object.entries(sbn)) {
      counts[name] = (counts[name] ?? 0) + 1
      sums[name] = (sums[name] ?? 0) + v
    }
  }
  const out: Record<string, number> = {}
  for (const name of Object.keys(sums)) {
    out[name] = sums[name]! / counts[name]!
  }
  return out
}

function averageLabels(labelsByName: Record<string, string>[]): Record<string, Record<string, number>> {
  const counts: Record<string, number> = {}
  const sums: Record<string, Record<string, number>> = {}
  for (const lbn of labelsByName) {
    for (const [name, label] of Object.entries(lbn)) {
      counts[name] = (counts[name] ?? 0) + 1
      if (!(name in sums)) sums[name] = {}
      sums[name]![label] = (sums[name]![label] ?? 0) + 1
    }
  }
  const out: Record<string, Record<string, number>> = {}
  for (const name of Object.keys(sums)) {
    out[name] = {}
    for (const [lbl, c] of Object.entries(sums[name]!)) {
      out[name][lbl] = c / counts[name]!
    }
  }
  return out
}

export function aggregateAverage(cases: ReportCase[]): ReportCaseAggregate {
  const numCases = cases.length
  if (numCases === 0) {
    return { assertions: null, labels: {}, metrics: {}, name: 'Averages', scores: {}, taskDuration: 0, totalDuration: 0 }
  }
  const avgTaskDuration = cases.reduce((a, c) => a + c.taskDuration, 0) / numCases
  const avgTotalDuration = cases.reduce((a, c) => a + c.totalDuration, 0) / numCases
  const avgScores = averageScores(cases.map((c) => Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [k, v.value]))))
  const avgLabels = averageLabels(cases.map((c) => Object.fromEntries(Object.entries(c.labels).map(([k, v]) => [k, v.value]))))
  const avgMetrics = averageScores(cases.map((c) => c.metrics))
  const nAssertions = cases.reduce((a, c) => a + Object.keys(c.assertions).length, 0)
  let avgAssertions: null | number = null
  if (nAssertions > 0) {
    const nPassing = cases.reduce((a, c) => a + Object.values(c.assertions).filter((x) => x.value).length, 0)
    avgAssertions = nPassing / nAssertions
  }
  return {
    assertions: avgAssertions,
    labels: avgLabels,
    metrics: avgMetrics,
    name: 'Averages',
    scores: avgScores,
    taskDuration: avgTaskDuration,
    totalDuration: avgTotalDuration,
  }
}

export function aggregateAverageFromAggregates(aggregates: ReportCaseAggregate[]): ReportCaseAggregate {
  if (aggregates.length === 0) {
    return { assertions: null, labels: {}, metrics: {}, name: 'Averages', scores: {}, taskDuration: 0, totalDuration: 0 }
  }
  function avgNumericDicts(dicts: Record<string, number>[]): Record<string, number> {
    const allKeys = new Set<string>()
    for (const d of dicts) for (const k of Object.keys(d)) allKeys.add(k)
    const out: Record<string, number> = {}
    for (const k of allKeys) {
      const vals = dicts.filter((d) => k in d).map((d) => d[k]!)
      if (vals.length > 0) out[k] = vals.reduce((a, b) => a + b, 0) / vals.length
    }
    return out
  }
  const avgScores = avgNumericDicts(aggregates.map((a) => a.scores))
  const avgMetrics = avgNumericDicts(aggregates.map((a) => a.metrics))
  const allLabelKeys = new Set<string>()
  for (const a of aggregates) for (const k of Object.keys(a.labels)) allLabelKeys.add(k)
  const avgLabels: Record<string, Record<string, number>> = {}
  for (const k of allLabelKeys) {
    const combined: Record<string, number> = {}
    let count = 0
    for (const a of aggregates) {
      if (k in a.labels) {
        count += 1
        for (const [lv, freq] of Object.entries(a.labels[k]!)) {
          combined[lv] = (combined[lv] ?? 0) + freq
        }
      }
    }
    avgLabels[k] = {}
    for (const [lv, v] of Object.entries(combined)) avgLabels[k][lv] = v / count
  }
  const assertionVals = aggregates.filter((a) => a.assertions !== null).map((a) => a.assertions!)
  const avgAssertions = assertionVals.length > 0 ? assertionVals.reduce((a, b) => a + b, 0) / assertionVals.length : null
  const taskDurs = aggregates.map((a) => a.taskDuration)
  const totalDurs = aggregates.map((a) => a.totalDuration)
  return {
    assertions: avgAssertions,
    labels: avgLabels,
    metrics: avgMetrics,
    name: 'Averages',
    scores: avgScores,
    taskDuration: taskDurs.reduce((a, b) => a + b, 0) / taskDurs.length,
    totalDuration: totalDurs.reduce((a, b) => a + b, 0) / totalDurs.length,
  }
}

export interface RenderOptions {
  baseline?: EvaluationReport | null
  includeAnalyses?: boolean
  includeAverages?: boolean
  includeDurations?: boolean
  includeErrors?: boolean
  includeEvaluatorFailures?: boolean
  includeExpectedOutput?: boolean
  includeInput?: boolean
  includeMetadata?: boolean
  includeOutput?: boolean
  includeReasons?: boolean
  includeTotalDuration?: boolean
}

export class EvaluationReport<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  analyses: ReportAnalysis[]
  cases: ReportCase<InputsT, OutputT, MetadataT>[]
  experimentMetadata: null | Record<string, unknown>
  failures: ReportCaseFailure<InputsT, OutputT, MetadataT>[]
  name: string
  reportEvaluatorFailures: EvaluatorFailure[]
  spanId: null | string
  traceId: null | string

  constructor(params: {
    analyses?: ReportAnalysis[]
    cases: ReportCase<InputsT, OutputT, MetadataT>[]
    experimentMetadata?: null | Record<string, unknown>
    failures?: ReportCaseFailure<InputsT, OutputT, MetadataT>[]
    name: string
    reportEvaluatorFailures?: EvaluatorFailure[]
    spanId?: null | string
    traceId?: null | string
  }) {
    this.name = params.name
    this.cases = params.cases
    this.failures = params.failures ?? []
    this.analyses = params.analyses ?? []
    this.reportEvaluatorFailures = params.reportEvaluatorFailures ?? []
    this.experimentMetadata = params.experimentMetadata ?? null
    this.traceId = params.traceId ?? null
    this.spanId = params.spanId ?? null
  }

  averages(): null | ReportCaseAggregate {
    const groups = this.caseGroups()
    if (groups !== null) {
      const nonEmpty = groups.filter((g) => g.runs.length > 0).map((g) => g.summary)
      return nonEmpty.length > 0 ? aggregateAverageFromAggregates(nonEmpty) : null
    }
    if (this.cases.length > 0) {
      return aggregateAverage(this.cases)
    }
    return null
  }

  caseGroups(): null | ReportCaseGroup<InputsT, OutputT, MetadataT>[] {
    const anySource = this.cases.some((c) => c.sourceCaseName !== null) || this.failures.some((f) => f.sourceCaseName !== null)
    if (!anySource) return null
    const groups = new Map<
      string,
      { failures: ReportCaseFailure<InputsT, OutputT, MetadataT>[]; runs: ReportCase<InputsT, OutputT, MetadataT>[] }
    >()
    for (const c of this.cases) {
      const key = c.sourceCaseName ?? c.name
      if (!groups.has(key)) groups.set(key, { failures: [], runs: [] })
      groups.get(key)!.runs.push(c)
    }
    for (const f of this.failures) {
      const key = f.sourceCaseName ?? f.name
      if (!groups.has(key)) groups.set(key, { failures: [], runs: [] })
      groups.get(key)!.failures.push(f)
    }
    const result: ReportCaseGroup<InputsT, OutputT, MetadataT>[] = []
    for (const [groupName, { failures, runs }] of groups) {
      const first: ReportCase<InputsT, OutputT, MetadataT> | ReportCaseFailure<InputsT, OutputT, MetadataT> = runs[0] ?? failures[0]!
      result.push({
        expectedOutput: first.expectedOutput,
        failures,
        inputs: first.inputs,
        metadata: first.metadata,
        name: groupName,
        runs,
        summary: aggregateAverage(runs),
      })
    }
    return result
  }

  render(options: RenderOptions = {}): string {
    return renderReport(this, options)
  }

  toString(): string {
    return this.render()
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function padCells(rows: string[][]): string[][] {
  if (rows.length === 0) return rows
  const colCount = Math.max(...rows.map((r) => r.length))
  const widths = new Array<number>(colCount).fill(0)
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? ''
      const maxLine = cell.split('\n').reduce((m, l) => Math.max(m, l.length), 0)
      if (maxLine > widths[i]!) widths[i] = maxLine
    }
  }
  const padded: string[][] = []
  for (const row of rows) {
    const cells = row.map((c, i) => {
      const lines = c.split('\n')
      return lines.map((l) => l + ' '.repeat(Math.max(0, widths[i]! - l.length))).join('\n')
    })
    padded.push(cells)
  }
  return padded
}

function renderTable(headers: string[], rows: string[][], title: string): string {
  const allRows = [headers, ...rows]
  const padded = padCells(allRows)
  const lines: string[] = []
  if (title.length > 0) lines.push(title)
  for (let r = 0; r < padded.length; r++) {
    const row = padded[r]!
    const rowLinesCount = Math.max(...row.map((c) => c.split('\n').length))
    for (let lineIdx = 0; lineIdx < rowLinesCount; lineIdx++) {
      const parts = row.map((c) => {
        const rowLines = c.split('\n')
        return rowLines[lineIdx] ?? ' '.repeat(rowLines[0]!.length)
      })
      lines.push(`| ${parts.join(' | ')} |`)
    }
    if (r === 0) {
      const sep = row.map((c) => '-'.repeat(c.split('\n')[0]!.length))
      lines.push(`|-${sep.join('-|-')}-|`)
    }
  }
  return lines.join('\n')
}

function renderDict<T>(entries: [string, T][], format: (v: T) => string): string {
  if (entries.length === 0) return '-'
  return entries.map(([k, v]) => `${k}: ${format(v)}`).join('\n')
}

function renderAssertions(assertions: EvaluationResult<boolean>[], includeReasons: boolean): string {
  if (assertions.length === 0) return '-'
  return assertions
    .map((a) => {
      let line = a.value ? '✔' : '✗'
      if (includeReasons) {
        line = `${a.name}: ${line}`
        if (a.reason !== null && a.reason !== '') line += `\n  Reason: ${a.reason}`
      }
      return line
    })
    .join('\n')
}

function renderAnalysis(a: ReportAnalysis): string {
  if (a.type === 'confusion_matrix') {
    const headers = ['Expected \\ Predicted', ...a.classLabels]
    const rows = a.classLabels.map((l, i) => [l, ...(a.matrix[i] ?? []).map((v) => String(v))])
    return renderTable(headers, rows, a.title)
  }
  if (a.type === 'scalar') {
    const unit = a.unit !== null && a.unit !== undefined ? ` ${a.unit}` : ''
    return `${a.title}: ${String(a.value)}${unit}`
  }
  if (a.type === 'precision_recall') {
    const lines = [a.title]
    for (const curve of a.curves) {
      const auc = curve.auc !== null && curve.auc !== undefined ? `, AUC=${curve.auc.toFixed(4)}` : ''
      lines.push(`  ${curve.name}: ${String(curve.points.length)} points${auc}`)
    }
    return lines.join('\n')
  }
  if (a.type === 'line_plot') {
    const lines = [a.title]
    for (const curve of a.curves) {
      lines.push(`  ${curve.name}: ${String(curve.points.length)} points`)
    }
    return lines.join('\n')
  }
  // table
  const rows = a.rows.map((r) => r.map((v) => (v === null ? '' : String(v))))
  return renderTable(a.columns, rows, a.title)
}

function renderReport(report: EvaluationReport, options: RenderOptions): string {
  const includeInput = options.includeInput ?? false
  const includeMetadata = options.includeMetadata ?? false
  const includeExpectedOutput = options.includeExpectedOutput ?? false
  const includeOutput = options.includeOutput ?? false
  const includeDurations = options.includeDurations ?? true
  const includeTotalDuration = options.includeTotalDuration ?? false
  const includeAverages = options.includeAverages ?? true
  const includeErrors = options.includeErrors ?? true
  const includeEvaluatorFailures = options.includeEvaluatorFailures ?? true
  const includeAnalyses = options.includeAnalyses ?? true
  const includeReasons = options.includeReasons ?? false

  const cases = report.cases
  const hasScores = cases.some((c) => Object.keys(c.scores).length > 0)
  const hasLabels = cases.some((c) => Object.keys(c.labels).length > 0)
  const hasMetrics = cases.some((c) => Object.keys(c.metrics).length > 0)
  const hasAssertions = cases.some((c) => Object.keys(c.assertions).length > 0)
  const hasEvaluatorFailures = includeEvaluatorFailures && cases.some((c) => c.evaluatorFailures.length > 0)

  const headers: string[] = ['Case ID']
  if (includeInput) headers.push('Inputs')
  if (includeMetadata) headers.push('Metadata')
  if (includeExpectedOutput) headers.push('Expected Output')
  if (includeOutput) headers.push('Outputs')
  if (hasScores) headers.push('Scores')
  if (hasLabels) headers.push('Labels')
  if (hasMetrics) headers.push('Metrics')
  if (hasAssertions) headers.push('Assertions')
  if (hasEvaluatorFailures) headers.push('Evaluator Failures')
  if (includeDurations) headers.push(includeTotalDuration ? 'Durations' : 'Duration')

  const tableRows: string[][] = []
  for (const c of cases) {
    const row: string[] = [c.name]
    if (includeInput) row.push(formatValue(c.inputs))
    if (includeMetadata) row.push(formatValue(c.metadata))
    if (includeExpectedOutput) row.push(formatValue(c.expectedOutput))
    if (includeOutput) row.push(formatValue(c.output))
    if (hasScores) row.push(renderDict(Object.entries(c.scores), (r) => defaultRenderNumber(r.value)))
    if (hasLabels) row.push(renderDict(Object.entries(c.labels), (r) => r.value))
    if (hasMetrics) row.push(renderDict(Object.entries(c.metrics), (v) => defaultRenderNumber(v)))
    if (hasAssertions) row.push(renderAssertions(Object.values(c.assertions), includeReasons))
    if (hasEvaluatorFailures) {
      row.push(c.evaluatorFailures.length > 0 ? c.evaluatorFailures.map((f) => `${f.name}: ${f.errorMessage}`).join('\n') : '-')
    }
    if (includeDurations) {
      const parts: string[] = []
      if (includeTotalDuration) {
        parts.push(`task: ${defaultRenderDuration(c.taskDuration)}`)
        parts.push(`total: ${defaultRenderDuration(c.totalDuration)}`)
      } else {
        parts.push(defaultRenderDuration(c.taskDuration))
      }
      row.push(parts.join('\n'))
    }
    tableRows.push(row)
  }

  if (includeAverages) {
    const avg = report.averages()
    if (avg !== null) {
      const row: string[] = [avg.name]
      if (includeInput) row.push('')
      if (includeMetadata) row.push('')
      if (includeExpectedOutput) row.push('')
      if (includeOutput) row.push('')
      if (hasScores) row.push(renderDict(Object.entries(avg.scores), (v) => defaultRenderNumber(v)))
      if (hasLabels)
        row.push(
          renderDict(Object.entries(avg.labels), (dist) =>
            Object.entries(dist)
              .map(([k, v]) => `${k}=${defaultRenderPercentage(v)}`)
              .join(', ')
          )
        )
      if (hasMetrics) row.push(renderDict(Object.entries(avg.metrics), (v) => defaultRenderNumber(v)))
      if (hasAssertions) row.push(avg.assertions !== null ? `${defaultRenderPercentage(avg.assertions)} ✔` : '')
      if (hasEvaluatorFailures) row.push('')
      if (includeDurations) {
        if (includeTotalDuration) {
          row.push(`task: ${defaultRenderDuration(avg.taskDuration)}\ntotal: ${defaultRenderDuration(avg.totalDuration)}`)
        } else {
          row.push(defaultRenderDuration(avg.taskDuration))
        }
      }
      tableRows.push(row)
    }
  }

  const baselineName = options.baseline?.name
  const tableTitle = options.baseline
    ? `Evaluation Diff: ${baselineName === report.name ? report.name : `${baselineName} → ${report.name}`}`
    : `Evaluation Summary: ${report.name}`

  let output = renderTable(headers, tableRows, tableTitle)

  if (options.baseline) {
    // Baseline diff - use render number diff for scores/metrics
    output += '\n\n(Baseline diff rendering simplified - see individual case data for details)'
    // For full diff support we could implement a separate renderer; current behavior covers the summary case
  }

  if (includeAnalyses && report.analyses.length > 0) {
    for (const a of report.analyses) {
      output += '\n\n' + renderAnalysis(a)
    }
  }

  if (includeEvaluatorFailures && report.reportEvaluatorFailures.length > 0) {
    output += '\n\nReport Evaluator Failures:'
    for (const f of report.reportEvaluatorFailures) {
      output += `\n  ${f.name}: ${f.errorMessage}`
    }
  }

  if (includeErrors && report.failures.length > 0) {
    const headers = ['Case ID', 'Error Message']
    const rows = report.failures.map((f) => [f.name, f.errorMessage])
    output += '\n\n' + renderTable(headers, rows, 'Case Failures')
  }

  // Expose diff helpers to avoid unused warnings
  void defaultRenderNumberDiff
  void defaultRenderDurationDiff

  return output
}
