/**
 * Report types — what `Dataset.evaluate` returns. Mirrors pydantic-evals'
 * `ReportCase` / `ReportCaseFailure` / `EvaluationReport`.
 */

import type { ReportAnalysis } from './ReportEvaluator'
import type { EvaluationResultJson, EvaluatorFailureRecord } from './types'

export interface ReportCase<Inputs = unknown, Output = unknown, Metadata = unknown> {
  assertions: Record<string, EvaluationResultJson>
  attributes: Record<string, unknown>
  evaluator_failures: EvaluatorFailureRecord[]
  expected_output?: Output
  inputs: Inputs
  labels: Record<string, EvaluationResultJson>
  metadata?: Metadata
  metrics: Record<string, number>
  name: string
  output: Output
  scores: Record<string, EvaluationResultJson>
  source_case_name?: string
  span_id: null | string
  task_duration: number
  total_duration: number
  trace_id: null | string
}

export interface ReportCaseFailure<Inputs = unknown, Output = unknown, Metadata = unknown> {
  error_message: string
  error_stacktrace?: string
  error_type: string
  expected_output?: Output
  inputs: Inputs
  metadata?: Metadata
  name: string
  source_case_name?: string
  span_id: null | string
  trace_id: null | string
}

export interface EvaluationReport<Inputs = unknown, Output = unknown, Metadata = unknown> {
  analyses: ReportAnalysis[]
  cases: ReportCase<Inputs, Output, Metadata>[]
  experiment_metadata?: Record<string, unknown>
  failures: ReportCaseFailure<Inputs, Output, Metadata>[]
  name: string
  report_evaluator_failures: EvaluatorFailureRecord[]
  span_id: null | string
  trace_id: null | string
}

export interface ReportCaseAggregate {
  assertions: null | number
  labels: Record<string, Record<string, number>>
  metrics: Record<string, { count: number; mean: number }>
  name: string
  scores: Record<string, { count: number; mean: number }>
  task_duration: number
  total_duration: number
}

/**
 * A group of runs that share a `source_case_name`. Computed view returned by
 * `caseGroups()` for multi-run experiments (mirrors Python's `ReportCaseGroup`).
 */
export interface ReportCaseGroup<Inputs = unknown, Output = unknown, Metadata = unknown> {
  expected_output?: Output
  failures: ReportCaseFailure<Inputs, Output, Metadata>[]
  inputs: Inputs
  metadata?: Metadata
  name: string
  runs: ReportCase<Inputs, Output, Metadata>[]
  summary: ReportCaseAggregate
}

/**
 * Compute `assertion_pass_rate` across the cases. Returns `null` if there are
 * no assertions.
 */
export function computeAssertionPassRate(cases: readonly ReportCase[]): null | number {
  let total = 0
  let passed = 0
  for (const c of cases) {
    for (const a of Object.values(c.assertions)) {
      total += 1
      if (a.value === true) {
        passed += 1
      }
    }
  }
  if (total === 0) {
    return null
  }
  return passed / total
}

/**
 * Compute the `averages` block stored under `logfire.experiment.metadata.averages`.
 * Required by the platform's sort-by-pass-rate UI.
 */
export function computeAverages(name: string, cases: readonly ReportCase[]): ReportCaseAggregate {
  const scoresAcc: Record<string, { count: number; sum: number }> = {}
  const metricsAcc: Record<string, { count: number; sum: number }> = {}
  const labelsAcc: Record<string, Record<string, number>> = {}
  let assertionsTotal = 0
  let assertionsPassed = 0
  let taskDurationSum = 0
  let totalDurationSum = 0

  for (const c of cases) {
    for (const [k, r] of Object.entries(c.scores)) {
      const acc = (scoresAcc[k] ??= { count: 0, sum: 0 })
      if (typeof r.value === 'number') {
        acc.count += 1
        acc.sum += r.value
      }
    }
    for (const [k, v] of Object.entries(c.metrics)) {
      const acc = (metricsAcc[k] ??= { count: 0, sum: 0 })
      acc.count += 1
      acc.sum += v
    }
    for (const [k, r] of Object.entries(c.labels)) {
      const dist = (labelsAcc[k] ??= {})
      const lv = String(r.value)
      dist[lv] = (dist[lv] ?? 0) + 1
    }
    for (const a of Object.values(c.assertions)) {
      assertionsTotal += 1
      if (a.value === true) {
        assertionsPassed += 1
      }
    }
    taskDurationSum += c.task_duration
    totalDurationSum += c.total_duration
  }

  const scores: ReportCaseAggregate['scores'] = {}
  for (const [k, { count, sum }] of Object.entries(scoresAcc)) {
    scores[k] = { count, mean: count === 0 ? 0 : sum / count }
  }
  const metrics: ReportCaseAggregate['metrics'] = {}
  for (const [k, { count, sum }] of Object.entries(metricsAcc)) {
    metrics[k] = { count, mean: count === 0 ? 0 : sum / count }
  }
  const labels: ReportCaseAggregate['labels'] = {}
  for (const [k, counts] of Object.entries(labelsAcc)) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
    labels[k] = {}
    for (const [label, count] of Object.entries(counts)) {
      labels[k][label] = total === 0 ? 0 : count / total
    }
  }

  const n = cases.length === 0 ? 1 : cases.length
  return {
    assertions: assertionsTotal === 0 ? null : assertionsPassed / assertionsTotal,
    labels,
    metrics,
    name,
    scores,
    task_duration: taskDurationSum / n,
    total_duration: totalDurationSum / n,
  }
}

/**
 * Group runs by `source_case_name` and compute per-group aggregates. Returns
 * `undefined` when no case or failure has a `source_case_name` set (i.e., a
 * single-run experiment). Mirrors Python's `EvaluationReport.case_groups()`.
 */
export function caseGroups<Inputs = unknown, Output = unknown, Metadata = unknown>(
  report: EvaluationReport<Inputs, Output, Metadata>
): ReportCaseGroup<Inputs, Output, Metadata>[] | undefined {
  const hasSource =
    report.cases.some((c) => c.source_case_name !== undefined) || report.failures.some((f) => f.source_case_name !== undefined)
  if (!hasSource) {
    return undefined
  }

  const groups = new Map<
    string,
    { failures: ReportCaseFailure<Inputs, Output, Metadata>[]; runs: ReportCase<Inputs, Output, Metadata>[] }
  >()
  const ensure = (key: string) => {
    let g = groups.get(key)
    if (g === undefined) {
      g = { failures: [], runs: [] }
      groups.set(key, g)
    }
    return g
  }
  for (const c of report.cases) {
    ensure(c.source_case_name ?? c.name).runs.push(c)
  }
  for (const f of report.failures) {
    ensure(f.source_case_name ?? f.name).failures.push(f)
  }

  const result: ReportCaseGroup<Inputs, Output, Metadata>[] = []
  for (const [name, { failures, runs }] of groups) {
    // ensure() only inserts a group when a case or failure is added, so at least one of the two arrays is non-empty.
    const first = runs[0] ?? failures[0]
    if (first === undefined) {
      continue
    }
    const group: ReportCaseGroup<Inputs, Output, Metadata> = {
      failures,
      inputs: first.inputs,
      name,
      runs,
      summary: computeAverages('Averages', runs),
    }
    if (first.expected_output !== undefined) {
      group.expected_output = first.expected_output
    }
    if (first.metadata !== undefined) {
      group.metadata = first.metadata
    }
    result.push(group)
  }
  return result
}

/**
 * Average across already-aggregated cases. Used to roll multi-run group
 * summaries up into a single experiment-wide aggregate. Mirrors Python's
 * `ReportCaseAggregate.average_from_aggregates`.
 *
 * For each key, only aggregates that contain the key contribute (so a key
 * present in 2/3 aggregates averages over 2 entries). Counts are summed.
 */
export function averageFromAggregates(name: string, aggregates: readonly ReportCaseAggregate[]): ReportCaseAggregate {
  if (aggregates.length === 0) {
    return { assertions: null, labels: {}, metrics: {}, name, scores: {}, task_duration: 0, total_duration: 0 }
  }

  const avgCountMean = (key: 'metrics' | 'scores'): Record<string, { count: number; mean: number }> => {
    const out: Record<string, { count: number; mean: number; n: number; sum: number }> = {}
    for (const agg of aggregates) {
      for (const [k, { count, mean }] of Object.entries(agg[key])) {
        const acc = (out[k] ??= { count: 0, mean: 0, n: 0, sum: 0 })
        acc.sum += mean
        acc.n += 1
        acc.count += count
      }
    }
    const result: Record<string, { count: number; mean: number }> = {}
    for (const [k, { count, n, sum }] of Object.entries(out)) {
      result[k] = { count, mean: sum / n }
    }
    return result
  }

  const avgLabels: Record<string, Record<string, number>> = {}
  const labelKeys = new Set<string>()
  for (const a of aggregates) {
    for (const k of Object.keys(a.labels)) {
      labelKeys.add(k)
    }
  }
  for (const key of labelKeys) {
    const combined: Record<string, number> = {}
    let n = 0
    for (const a of aggregates) {
      const dist = a.labels[key]
      if (dist === undefined) {
        continue
      }
      n += 1
      for (const [labelVal, freq] of Object.entries(dist)) {
        combined[labelVal] = (combined[labelVal] ?? 0) + freq
      }
    }
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(combined)) {
      out[k] = v / n
    }
    avgLabels[key] = out
  }

  const assertionVals = aggregates.map((a) => a.assertions).filter((v): v is number => v !== null)
  const avgAssertions = assertionVals.length === 0 ? null : assertionVals.reduce((s, v) => s + v, 0) / assertionVals.length

  const taskSum = aggregates.reduce((s, a) => s + a.task_duration, 0)
  const totalSum = aggregates.reduce((s, a) => s + a.total_duration, 0)

  return {
    assertions: avgAssertions,
    labels: avgLabels,
    metrics: avgCountMean('metrics'),
    name,
    scores: avgCountMean('scores'),
    task_duration: taskSum / aggregates.length,
    total_duration: totalSum / aggregates.length,
  }
}

/**
 * Compute the experiment-wide aggregate for a report. For multi-run reports
 * (any case has `source_case_name`), uses two-level aggregation: average each
 * source-case group, then average the group summaries. For single-run reports,
 * averages the cases directly. Returns `undefined` if there are no cases.
 *
 * Mirrors Python's `EvaluationReport.averages()`.
 */
export function averages<Inputs = unknown, Output = unknown, Metadata = unknown>(
  report: EvaluationReport<Inputs, Output, Metadata>
): ReportCaseAggregate | undefined {
  const groups = caseGroups(report)
  if (groups !== undefined) {
    const nonEmpty = groups.filter((g) => g.runs.length > 0).map((g) => g.summary)
    if (nonEmpty.length === 0) {
      return undefined
    }
    return averageFromAggregates('Averages', nonEmpty)
  }
  if (report.cases.length > 0) {
    return computeAverages('Averages', report.cases)
  }
  return undefined
}
