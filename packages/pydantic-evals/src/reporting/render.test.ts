import { describe, expect, test } from 'vitest'

import {
  defaultRenderDuration,
  defaultRenderDurationDiff,
  defaultRenderNumber,
  defaultRenderNumberDiff,
  defaultRenderPercentage,
} from './renderNumbers'
import { aggregateAverage, aggregateAverageFromAggregates, EvaluationReport } from './report'

describe('renderNumbers', () => {
  test('defaultRenderNumber formats integers and floats', () => {
    expect(defaultRenderNumber(1000)).toBe('1,000')
    expect(defaultRenderNumber(0)).toBe('0')
    expect(defaultRenderNumber(12.345)).toBe('12.3')
    expect(defaultRenderNumber(0.0001234)).toBe('0.000123')
    expect(defaultRenderNumber(0.0)).toBe('0')
  })

  test('defaultRenderNumber for float zero', () => {
    expect(defaultRenderNumber(0.5)).toBe('0.500')
    // Non-integer with tailing zero
    expect(defaultRenderNumber(1.5)).toBe('1.50')
  })

  test('defaultRenderPercentage', () => {
    expect(defaultRenderPercentage(0.5)).toBe('50.0%')
    expect(defaultRenderPercentage(1)).toBe('100.0%')
  })

  test('defaultRenderNumberDiff int', () => {
    expect(defaultRenderNumberDiff(3, 4)).toBe('+1')
    expect(defaultRenderNumberDiff(5, 5)).toBeNull()
    expect(defaultRenderNumberDiff(5, 3)).toBe('-2')
  })

  test('defaultRenderNumberDiff float', () => {
    const s = defaultRenderNumberDiff(1.0, 1.5)
    expect(s).toContain('+')
    expect(s).toContain('%')
  })

  test('defaultRenderNumberDiff with zero base', () => {
    const s = defaultRenderNumberDiff(0, 1.5)
    expect(s).toContain('+1')
  })

  test('defaultRenderNumberDiff with small values', () => {
    const s = defaultRenderNumberDiff(1e-4, 1e-3)
    expect(s).not.toBeNull()
  })

  test('defaultRenderDuration', () => {
    expect(defaultRenderDuration(0)).toBe('0s')
    expect(defaultRenderDuration(2)).toContain('s')
    expect(defaultRenderDuration(0.5)).toContain('ms')
    expect(defaultRenderDuration(0.0000005)).toContain('µs')
    expect(defaultRenderDuration(0.5e-6)).toContain('µs')
  })

  test('defaultRenderDurationDiff', () => {
    expect(defaultRenderDurationDiff(1, 1)).toBeNull()
    expect(defaultRenderDurationDiff(1, 2)).toContain('+')
  })

  test('defaultRenderNumberDiff large multiplier', () => {
    const s = defaultRenderNumberDiff(1.5, 500.5)
    expect(s).toContain('x')
  })

  test('defaultRenderNumberDiff small change returns null relative', () => {
    // Very small diff should only give abs diff
    const s = defaultRenderNumberDiff(100.0, 100.001)
    expect(s).not.toBeNull()
  })
})

describe('EvaluationReport', () => {
  const makeCase = (
    overrides: Partial<{
      assertions: Record<string, { name: string; reason: null | string; source: { arguments: null; name: string }; value: boolean }>
      metrics: Record<string, number>
      name: string
      output: unknown
      scores: Record<string, { name: string; reason: null | string; source: { arguments: null; name: string }; value: number }>
      sourceCaseName: null | string
    }> = {}
  ) => ({
    assertions: overrides.assertions ?? {},
    attributes: {},
    evaluatorFailures: [],
    expectedOutput: null,
    inputs: {},
    labels: {},
    metadata: null,
    metrics: overrides.metrics ?? {},
    name: overrides.name ?? 'c',
    output: overrides.output ?? null,
    scores: overrides.scores ?? {},
    sourceCaseName: overrides.sourceCaseName ?? null,
    spanId: null,
    taskDuration: 0.01,
    totalDuration: 0.02,
    traceId: null,
  })

  test('aggregateAverage empty', () => {
    expect(aggregateAverage([]).assertions).toBeNull()
  })

  test('aggregateAverage with data', () => {
    const spec = { arguments: null, name: 'x' }
    const cases = [
      makeCase({
        assertions: { a: { name: 'a', reason: null, source: spec, value: true } },
        metrics: { m: 2 },
        name: 'c1',
        scores: { s: { name: 's', reason: null, source: spec, value: 1 } },
      }),
      makeCase({
        assertions: { a: { name: 'a', reason: null, source: spec, value: false } },
        metrics: { m: 4 },
        name: 'c2',
        scores: { s: { name: 's', reason: null, source: spec, value: 3 } },
      }),
    ]
    const agg = aggregateAverage(cases)
    expect(agg.scores.s).toBe(2)
    expect(agg.metrics.m).toBe(3)
    expect(agg.assertions).toBe(0.5)
  })

  test('aggregateAverageFromAggregates empty', () => {
    expect(aggregateAverageFromAggregates([]).assertions).toBeNull()
  })

  test('aggregateAverageFromAggregates combines', () => {
    const agg1 = aggregateAverage([makeCase({ metrics: { m: 1 }, scores: {} })])
    const agg2 = aggregateAverage([makeCase({ metrics: { m: 3 }, scores: {} })])
    const combined = aggregateAverageFromAggregates([agg1, agg2])
    expect(combined.metrics.m).toBe(2)
  })

  test('aggregateAverageFromAggregates with labels and assertions', () => {
    const agg1 = { assertions: 0.8, labels: { L: { x: 1 } }, metrics: {}, name: 'Averages', scores: {}, taskDuration: 1, totalDuration: 2 }
    const agg2 = {
      assertions: 0.6,
      labels: { L: { x: 0.5, y: 0.5 } },
      metrics: {},
      name: 'Averages',
      scores: {},
      taskDuration: 3,
      totalDuration: 4,
    }
    const combined = aggregateAverageFromAggregates([agg1, agg2])
    expect(combined.assertions).toBeCloseTo(0.7)
    expect(combined.labels.L).toBeDefined()
  })

  test('render produces readable output', () => {
    const spec = { arguments: null, name: 'E' }
    const report = new EvaluationReport({
      cases: [
        makeCase({
          assertions: { e: { name: 'e', reason: null, source: spec, value: true } },
          metrics: { cost: 0.5 },
          name: 'c1',
          scores: { s: { name: 's', reason: null, source: spec, value: 0.9 } },
        }),
      ],
      name: 'test',
    })
    const output = report.render({ includeInput: true, includeMetadata: true, includeOutput: true })
    expect(output).toContain('test')
    expect(output).toContain('c1')
  })

  test('caseGroups returns null for single-run', () => {
    const report = new EvaluationReport({ cases: [makeCase({})], name: 'x' })
    expect(report.caseGroups()).toBeNull()
  })

  test('caseGroups with multi-run', () => {
    const report = new EvaluationReport({
      cases: [makeCase({ name: 'c1 [1/2]', sourceCaseName: 'c1' }), makeCase({ name: 'c1 [2/2]', sourceCaseName: 'c1' })],
      name: 'x',
    })
    const groups = report.caseGroups()
    expect(groups).toHaveLength(1)
    expect(groups?.[0]?.runs).toHaveLength(2)
  })

  test('averages returns null for empty', () => {
    const report = new EvaluationReport({ cases: [], name: 'x' })
    expect(report.averages()).toBeNull()
  })

  test('toString includes name', () => {
    const report = new EvaluationReport({ cases: [makeCase({ name: 'c1' })], name: 'report-name' })
    expect(report.toString()).toContain('report-name')
  })

  test('render includes reasons', () => {
    const spec = { arguments: null, name: 'E' }
    const report = new EvaluationReport({
      cases: [
        makeCase({
          assertions: { e: { name: 'e', reason: 'test reason', source: spec, value: false } },
          name: 'c1',
        }),
      ],
      name: 'r',
    })
    const output = report.render({ includeReasons: true })
    expect(output).toContain('c1')
  })

  test('render with total duration', () => {
    const report = new EvaluationReport({ cases: [makeCase({ name: 'c1' })], name: 'r' })
    const output = report.render({ includeTotalDuration: true })
    expect(output).toContain('task')
  })

  test('render with baseline', () => {
    const report = new EvaluationReport({ cases: [makeCase({ name: 'c1' })], name: 'new' })
    const baseline = new EvaluationReport({ cases: [makeCase({ name: 'c1' })], name: 'baseline' })
    const output = report.render({ baseline })
    expect(output).toContain('Diff')
  })

  test('render includes analyses', () => {
    const report = new EvaluationReport({ cases: [], name: 'r' })
    report.analyses.push({ title: 'x', type: 'scalar', value: 1 })
    report.analyses.push({ curves: [{ name: 'a', points: [{ x: 0, y: 0 }] }], title: 'lp', type: 'line_plot', x_label: 'x', y_label: 'y' })
    report.analyses.push({
      curves: [{ auc: 0.9, name: 'n', points: [{ precision: 1, recall: 0, threshold: 1 }] }],
      title: 'pr',
      type: 'precision_recall',
    })
    report.analyses.push({
      classLabels: ['A', 'B'],
      matrix: [
        [1, 0],
        [0, 1],
      ],
      title: 'cm',
      type: 'confusion_matrix',
    })
    report.analyses.push({ columns: ['x', 'y'], rows: [['a', null]], title: 't', type: 'table' })
    const output = report.render()
    expect(output).toContain('x: 1')
    expect(output).toContain('lp')
    expect(output).toContain('pr')
    expect(output).toContain('cm')
    expect(output).toContain('t')
  })

  test('render with failures', () => {
    const report = new EvaluationReport({
      cases: [makeCase({ name: 'c1' })],
      failures: [
        {
          errorMessage: 'kaboom',
          errorStacktrace: 'stack',
          expectedOutput: null,
          inputs: {},
          metadata: null,
          name: 'c2',
          sourceCaseName: null,
          spanId: null,
          traceId: null,
        },
      ],
      name: 'r',
    })
    expect(report.render()).toContain('kaboom')
  })

  test('render with report_evaluator_failures', () => {
    const report = new EvaluationReport({
      cases: [makeCase({ name: 'c1' })],
      name: 'r',
      reportEvaluatorFailures: [
        {
          errorMessage: 'bad',
          errorStacktrace: '',
          name: 'EvalX',
          source: { arguments: null, name: 'EvalX' },
        },
      ],
    })
    expect(report.render()).toContain('Report Evaluator Failures')
  })

  test('averages returns aggregate for groups with runs', () => {
    const spec = { arguments: null, name: 'x' }
    const report = new EvaluationReport({
      cases: [
        makeCase({
          assertions: { a: { name: 'a', reason: null, source: spec, value: true } },
          metrics: {},
          name: 'c [1/2]',
          scores: {},
          sourceCaseName: 'c',
        }),
        makeCase({
          assertions: { a: { name: 'a', reason: null, source: spec, value: false } },
          metrics: {},
          name: 'c [2/2]',
          scores: {},
          sourceCaseName: 'c',
        }),
      ],
      name: 'r',
    })
    expect(report.averages()).not.toBeNull()
  })
})
