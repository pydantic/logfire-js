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
 * Compute `assertion_pass_rate` across the cases. Returns `null` if there are
 * no assertions.
 */
export function computeAssertionPassRate(cases: readonly ReportCase[]): null | number {
  let total = 0
  let passed = 0
  for (const c of cases) {
    for (const a of Object.values(c.assertions)) {
      total += 1
      if (a.value === true) passed += 1
    }
  }
  if (total === 0) return null
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
      if (a.value === true) assertionsPassed += 1
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

  const n = cases.length === 0 ? 1 : cases.length
  return {
    assertions: assertionsTotal === 0 ? null : assertionsPassed / assertionsTotal,
    labels: labelsAcc,
    metrics,
    name,
    scores,
    task_duration: taskDurationSum / n,
    total_duration: totalDurationSum / n,
  }
}
