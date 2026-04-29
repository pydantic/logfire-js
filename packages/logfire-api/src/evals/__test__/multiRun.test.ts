/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'

import {
  averageFromAggregates,
  averages,
  Case,
  caseGroups,
  Dataset,
  type EvaluationReport,
  Evaluator,
  type ReportCase,
  type ReportCaseAggregate,
  type ReportCaseFailure,
} from '../../evals'
import { withMemoryExporter } from './withMemoryExporter'

const resultJson = (name: string, value: boolean | number | string) => ({
  name,
  reason: null,
  source: { arguments: null, name: 'Source' },
  value,
})

const makeReportCase = (overrides: Partial<ReportCase> = {}): ReportCase => ({
  assertions: {},
  attributes: {},
  evaluator_failures: [],
  inputs: 'input',
  labels: {},
  metrics: {},
  name: 'case',
  output: 'output',
  scores: {},
  span_id: null,
  task_duration: 1,
  total_duration: 1,
  trace_id: null,
  ...overrides,
})

const makeReport = (overrides: Partial<EvaluationReport> = {}): EvaluationReport => ({
  analyses: [],
  cases: [],
  failures: [],
  name: 'test',
  report_evaluator_failures: [],
  span_id: null,
  trace_id: null,
  ...overrides,
})

describe('repeat option', () => {
  it('repeat=1 produces single-run behavior with no source_case_name and caseGroups undefined', async () => {
    let calls = 0
    const dataset = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hello', name: 'case1' }), new Case({ inputs: 'world', name: 'case2' })],
      name: 'repeat-1',
    })

    const { result } = await withMemoryExporter(() =>
      dataset.evaluate(async (s) => {
        calls += 1
        return s.toUpperCase()
      })
    )

    expect(calls).toBe(2)
    expect(result.cases).toHaveLength(2)
    expect(result.cases.every((c) => c.source_case_name === undefined)).toBe(true)
    expect(caseGroups(result)).toBeUndefined()
  })

  it('repeat=3 produces 3x cases with run-indexed names and source_case_name set', async () => {
    let calls = 0
    const dataset = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hello', name: 'case1' }), new Case({ inputs: 'world', name: 'case2' })],
      name: 'repeat-3',
    })

    const { result } = await withMemoryExporter(() =>
      dataset.evaluate(
        async (s) => {
          calls += 1
          return s.toUpperCase()
        },
        { repeat: 3 }
      )
    )

    expect(calls).toBe(6)
    expect(result.cases).toHaveLength(6)
    expect([...result.cases].map((c) => c.name).sort()).toEqual([
      'case1 [1/3]',
      'case1 [2/3]',
      'case1 [3/3]',
      'case2 [1/3]',
      'case2 [2/3]',
      'case2 [3/3]',
    ])
    expect(result.cases.filter((c) => c.source_case_name === 'case1')).toHaveLength(3)
    expect(result.cases.filter((c) => c.source_case_name === 'case2')).toHaveLength(3)
  })

  it('repeat works with unnamed cases using positional fallback names', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hello' }), new Case({ inputs: 'world' })],
      name: 'unnamed',
    })

    const { result } = await withMemoryExporter(() => dataset.evaluate(async (s) => s.toUpperCase(), { repeat: 2 }))

    expect(result.cases).toHaveLength(4)
    expect([...result.cases].map((c) => c.name).sort()).toEqual(['Case 1 [1/2]', 'Case 1 [2/2]', 'Case 2 [1/2]', 'Case 2 [2/2]'])
    expect(result.cases.every((c) => c.source_case_name !== undefined)).toBe(true)
  })

  it('repeat < 1 throws', async () => {
    const dataset = new Dataset<string, string>({ cases: [new Case({ inputs: 'x' })], name: 'bad-repeat' })
    await expect(dataset.evaluate(async (s) => s, { repeat: 0 })).rejects.toThrow('repeat must be >= 1')
    await expect(dataset.evaluate(async (s) => s, { repeat: 1.5 })).rejects.toThrow('repeat must be >= 1')
  })

  it('evaluators run on every repeated run', async () => {
    class AlwaysPass extends Evaluator<string, string> {
      static evaluatorName = 'AlwaysPass'
      evaluate(): boolean {
        return true
      }
    }

    const dataset = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hello', name: 'case1' })],
      evaluators: [new AlwaysPass()],
      name: 'repeat-evaluators',
    })

    const { result } = await withMemoryExporter(() => dataset.evaluate(async (s) => s.toUpperCase(), { repeat: 3 }))

    expect(result.cases).toHaveLength(3)
    for (const c of result.cases) {
      expect(c.assertions.AlwaysPass?.value).toBe(true)
    }
  })
})

describe('caseGroups()', () => {
  it('groups runs by source_case_name and computes per-group summaries', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hello', name: 'case1' }), new Case({ inputs: 'world', name: 'case2' })],
      name: 'groups',
    })
    const { result } = await withMemoryExporter(() => dataset.evaluate(async (s) => s.toUpperCase(), { repeat: 2 }))

    const groups = caseGroups(result)
    expect(groups).toBeDefined()
    expect(groups).toHaveLength(2)
    expect([...groups!].map((g) => g.name).sort()).toEqual(['case1', 'case2'])
    for (const g of groups!) {
      expect(g.runs).toHaveLength(2)
      expect(g.failures).toHaveLength(0)
      expect(g.summary.name).toBe('Averages')
    }
  })

  it('returns undefined for single-run experiments', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hello', name: 'case1' })],
      name: 'single',
    })
    const { result } = await withMemoryExporter(() => dataset.evaluate(async (s) => s.toUpperCase()))
    expect(caseGroups(result)).toBeUndefined()
  })

  it('exposes group fields populated from the first run', () => {
    const case1 = makeReportCase({
      assertions: { AlwaysPass: resultJson('AlwaysPass', true) },
      inputs: 'hello',
      name: 'case1 [1/2]',
      source_case_name: 'case1',
      task_duration: 0.1,
      total_duration: 0.2,
    })
    const case2 = makeReportCase({
      assertions: { AlwaysPass: resultJson('AlwaysPass', true) },
      inputs: 'hello',
      name: 'case1 [2/2]',
      source_case_name: 'case1',
      task_duration: 0.15,
      total_duration: 0.25,
    })

    const groups = caseGroups(makeReport({ cases: [case1, case2] }))
    expect(groups).toHaveLength(1)
    const g = groups![0]!
    expect(g.name).toBe('case1')
    expect(g.inputs).toBe('hello')
    expect(g.metadata).toBeUndefined()
    expect(g.expected_output).toBeUndefined()
    expect(g.runs).toHaveLength(2)
    expect(g.failures).toHaveLength(0)
    expect(g.summary.task_duration).toBeCloseTo(0.125)
  })

  it('groups failures by source_case_name', () => {
    const case1: ReportCase = makeReportCase({ name: 'case1 [1/2]', source_case_name: 'case1' })
    const failure: ReportCaseFailure = {
      error_message: 'something went wrong',
      error_type: 'Error',
      inputs: 'hello',
      name: 'case1 [2/2]',
      source_case_name: 'case1',
      span_id: null,
      trace_id: null,
    }

    const groups = caseGroups(makeReport({ cases: [case1], failures: [failure] }))
    expect(groups).toHaveLength(1)
    const g = groups![0]!
    expect(g.name).toBe('case1')
    expect(g.runs).toHaveLength(1)
    expect(g.failures).toHaveLength(1)
    expect(g.failures[0]?.error_message).toBe('something went wrong')
  })
})

describe('averages()', () => {
  it('uses two-level aggregation for multi-run reports (distinguishes from flat mean)', () => {
    // case1 runs scored 0.2 and 0.4 → group mean 0.3
    // case2 has one run scored 0.9 and one failure
    // Two-level: mean(0.3, 0.9) = 0.6
    // Flat mean would be: mean(0.2, 0.4, 0.9) = 0.5
    const score = (v: number) => ({ score: resultJson('score', v) })
    const cases: ReportCase[] = [
      makeReportCase({ name: 'case1 [1/2]', scores: score(0.2), source_case_name: 'case1' }),
      makeReportCase({ name: 'case1 [2/2]', scores: score(0.4), source_case_name: 'case1' }),
      makeReportCase({ name: 'case2 [1/2]', scores: score(0.9), source_case_name: 'case2' }),
    ]
    const failures: ReportCaseFailure[] = [
      {
        error_message: 'failed',
        error_type: 'Error',
        inputs: 'world',
        name: 'case2 [2/2]',
        source_case_name: 'case2',
        span_id: null,
        trace_id: null,
      },
    ]

    const result = averages(makeReport({ cases, failures }))
    expect(result).toBeDefined()
    expect(result!.scores.score?.mean).toBeCloseTo(0.6)
  })

  it('falls back to flat averaging for single-run reports', () => {
    const cases: ReportCase[] = [
      makeReportCase({ scores: { s: resultJson('s', 0.2) } }),
      makeReportCase({ scores: { s: resultJson('s', 0.4) } }),
    ]
    const result = averages(makeReport({ cases }))
    expect(result).toBeDefined()
    expect(result!.name).toBe('Averages')
    expect(result!.scores.s?.mean).toBeCloseTo(0.3)
  })

  it('returns undefined for an empty report', () => {
    expect(averages(makeReport())).toBeUndefined()
  })
})

describe('averageFromAggregates()', () => {
  const makeAggregate = (overrides: Partial<ReportCaseAggregate>): ReportCaseAggregate => ({
    assertions: null,
    labels: {},
    metrics: {},
    name: 'Averages',
    scores: {},
    task_duration: 0,
    total_duration: 0,
    ...overrides,
  })

  it('averages numeric scores/metrics, label distributions, assertions, and durations', () => {
    const agg1 = makeAggregate({
      assertions: 1,
      labels: { l1: { a: 0.5, b: 0.5 } },
      metrics: { m1: { count: 1, mean: 10 } },
      scores: { s1: { count: 1, mean: 0.5 }, s2: { count: 1, mean: 0.25 } },
      task_duration: 1,
      total_duration: 2,
    })
    const agg2 = makeAggregate({
      assertions: 0.5,
      labels: { l1: { a: 0.25, b: 0.75 } },
      metrics: { m1: { count: 1, mean: 20 } },
      scores: { s1: { count: 1, mean: 0.5 }, s2: { count: 1, mean: 0.75 } },
      task_duration: 3,
      total_duration: 4,
    })

    const result = averageFromAggregates('Averages', [agg1, agg2])
    expect(result.name).toBe('Averages')
    expect(result.scores.s1?.mean).toBeCloseTo(0.5)
    expect(result.scores.s2?.mean).toBeCloseTo(0.5)
    expect(result.metrics.m1?.mean).toBeCloseTo(15)
    expect(result.assertions).toBeCloseTo(0.75)
    expect(result.task_duration).toBeCloseTo(2)
    expect(result.total_duration).toBeCloseTo(3)
    expect(result.labels.l1?.a).toBeCloseTo(0.375)
    expect(result.labels.l1?.b).toBeCloseTo(0.625)
  })

  it('returns an empty aggregate for an empty input', () => {
    expect(averageFromAggregates('Averages', [])).toEqual({
      assertions: null,
      labels: {},
      metrics: {},
      name: 'Averages',
      scores: {},
      task_duration: 0,
      total_duration: 0,
    })
  })

  it('handles partial keys (only averages over aggregates that have the key)', () => {
    const agg1 = makeAggregate({
      assertions: 1,
      labels: { sentiment: { negative: 0.2, positive: 0.8 } },
      metrics: { m1: { count: 1, mean: 10 } },
      scores: { s1: { count: 1, mean: 1 } },
      task_duration: 1,
      total_duration: 1,
    })
    const agg2 = makeAggregate({
      assertions: null,
      labels: { topic: { arts: 0.4, science: 0.6 } },
      metrics: { m2: { count: 1, mean: 20 } },
      scores: { s2: { count: 1, mean: 2 } },
      task_duration: 3,
      total_duration: 3,
    })

    const result = averageFromAggregates('Averages', [agg1, agg2])
    expect(result.scores.s1?.mean).toBeCloseTo(1)
    expect(result.scores.s2?.mean).toBeCloseTo(2)
    expect(result.metrics.m1?.mean).toBeCloseTo(10)
    expect(result.metrics.m2?.mean).toBeCloseTo(20)
    expect(result.labels.sentiment).toEqual({ negative: 0.2, positive: 0.8 })
    expect(result.labels.topic).toEqual({ arts: 0.4, science: 0.6 })
    expect(result.assertions).toBeCloseTo(1)
  })
})
