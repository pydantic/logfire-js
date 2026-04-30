/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, expect, it } from 'vite-plus/test'

import {
  Case,
  CaseLifecycle,
  computeAssertionPassRate,
  computeAverages,
  ConfusionMatrixEvaluator,
  Dataset,
  Equals,
  EqualsExpected,
  Evaluator,
  EXPERIMENT_ANALYSES_KEY,
  EXPERIMENT_REPORT_EVALUATOR_FAILURES_KEY,
  KolmogorovSmirnovEvaluator,
  PrecisionRecallEvaluator,
  renderReport,
  ReportEvaluator,
  ROCAUCEvaluator,
  SPAN_NAME_CASE,
  SPAN_NAME_EXPERIMENT,
} from '../../evals'
import type { EvaluationReport, EvaluatorContext, ReportCase, ReportCaseFailure, ReportEvaluatorContext } from '../../evals'
import { buildThresholdInputs, trapezoidalAuc, uniqueSortedThresholds } from '../reportEvaluators'
import { withMemoryExporter } from './withMemoryExporter'

const resultJson = (name: string, value: boolean | number | string) => ({
  name,
  reason: null,
  source: { arguments: null, name: 'Source' },
  value,
})

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
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
  task_duration: 0.1,
  total_duration: 0.2,
  trace_id: null,
  ...overrides,
})

describe('lifecycle hooks', () => {
  it('runs setup → task → prepareContext → evaluators → teardown in order', async () => {
    const order: string[] = []

    class TraceLifecycle extends CaseLifecycle<string, string> {
      override prepareContext(ctx: EvaluatorContext<string, string>): EvaluatorContext<string, string> {
        order.push('prepareContext')
        return ctx
      }
      override async setup(): Promise<void> {
        order.push('setup')
      }
      override async teardown(_result: ReportCase<string, string> | ReportCaseFailure<string, string>): Promise<void> {
        order.push(`teardown(${_result.name})`)
      }
    }

    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'hi', name: 'one' })],
      evaluators: [new EqualsExpected()],
      name: 'lifecycle-test',
    })

    await withMemoryExporter(async () => {
      await dataset.evaluate(
        async (input) => {
          order.push('task')
          return input.toUpperCase()
        },
        { lifecycle: TraceLifecycle }
      )
    })

    expect(order).toEqual(['setup', 'task', 'prepareContext', 'teardown(one)'])
  })

  it('teardown runs even when the task throws', async () => {
    const events: string[] = []
    class FailingLifecycle extends CaseLifecycle<string, string> {
      override async teardown(): Promise<void> {
        events.push('teardown')
      }
    }
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'a' })],
      name: 'teardown-test',
    })
    await withMemoryExporter(async () => {
      await ds.evaluate(
        () => {
          throw new Error('boom')
        },
        { lifecycle: FailingLifecycle }
      )
    })
    expect(events).toEqual(['teardown'])
  })

  it('records teardown errors on failed cases without rejecting the experiment', async () => {
    class TeardownThrows extends CaseLifecycle<string, string> {
      override async teardown(): Promise<void> {
        throw new Error('teardown boom')
      }
    }
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'a' })],
      name: 'teardown-failure-test',
    })

    const { result, spans } = await withMemoryExporter(async () =>
      ds.evaluate(
        () => {
          throw new Error('task boom')
        },
        { lifecycle: TeardownThrows }
      )
    )

    expect(result.cases).toHaveLength(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.error_message).toBe('task boom')
    const caseSpan = spans.find((s) => s.name === SPAN_NAME_CASE)
    expect(caseSpan?.events.some((event) => event.attributes?.['exception.message'] === 'teardown boom')).toBe(true)
  })

  it('records teardown errors on successful cases without rejecting the experiment', async () => {
    class TeardownThrows extends CaseLifecycle<string, string> {
      override async teardown(): Promise<void> {
        throw new Error('teardown boom')
      }
    }
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'a' })],
      name: 'teardown-success-test',
    })

    const { result, spans } = await withMemoryExporter(async () =>
      ds.evaluate((input) => input.toUpperCase(), { lifecycle: TeardownThrows })
    )

    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]?.output).toBe('A')
    expect(result.failures).toHaveLength(0)
    const caseSpan = spans.find((s) => s.name === SPAN_NAME_CASE)
    expect(caseSpan?.events.some((event) => event.attributes?.['exception.message'] === 'teardown boom')).toBe(true)
  })

  it('gives each case its own lifecycle instance with isolated state', async () => {
    class StatefulLifecycle extends CaseLifecycle<string, string> {
      private setupCalled = false
      override prepareContext(ctx: EvaluatorContext<string, string>): EvaluatorContext<string, string> {
        if (!this.setupCalled) {
          throw new Error('setup not called before prepareContext')
        }
        ctx.metrics['case_name_length'] = this.case.name?.length ?? 0
        return ctx
      }
      override async setup(): Promise<void> {
        this.setupCalled = true
      }
    }

    const ds = new Dataset<string, string>({
      cases: [
        new Case<string, string>({ inputs: 'a', name: 'short' }),
        new Case<string, string>({ inputs: 'b', name: 'much_longer_name' }),
      ],
      name: 'per-case-state',
    })
    const { result } = await withMemoryExporter(async () => ds.evaluate((s) => s.toUpperCase(), { lifecycle: StatefulLifecycle }))

    const byName = Object.fromEntries(result.cases.map((c) => [c.name, c.metrics]))
    expect(byName['short']?.['case_name_length']).toBe(5)
    expect(byName['much_longer_name']?.['case_name_length']).toBe(16)
  })

  it('lets evaluators see metrics added by prepareContext', async () => {
    class Enricher extends CaseLifecycle<string, string> {
      override prepareContext(ctx: EvaluatorContext<string, string>): EvaluatorContext<string, string> {
        ctx.metrics['enriched'] = 1
        return ctx
      }
    }

    class CheckMetric extends Evaluator<string, string> {
      static override evaluatorName = 'CheckMetric'
      evaluate(ctx: EvaluatorContext<string, string>): boolean {
        return ctx.metrics['enriched'] === 1
      }
    }

    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'one' })],
      evaluators: [new CheckMetric()],
      name: 'enriched-context',
    })
    const { result } = await withMemoryExporter(async () => ds.evaluate((s) => s, { lifecycle: Enricher }))
    expect(result.cases[0]?.assertions['CheckMetric']?.value).toBe(true)
  })

  it('records prepareContext errors as case failures without rejecting the experiment', async () => {
    const events: string[] = []
    class PrepareThrows extends CaseLifecycle<string, string> {
      override prepareContext(): EvaluatorContext<string, string> {
        throw new Error('prepare boom')
      }
      override async teardown(result: ReportCase<string, string> | ReportCaseFailure<string, string>): Promise<void> {
        events.push(`teardown(${result.name})`)
      }
    }
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'a' })],
      name: 'prepare-failure-test',
    })

    const { result, spans } = await withMemoryExporter(async () => ds.evaluate((input) => input, { lifecycle: PrepareThrows }))

    expect(result.cases).toHaveLength(0)
    expect(result.failures).toMatchObject([{ error_message: 'prepare boom', error_type: 'Error', name: 'a' }])
    expect(events).toEqual(['teardown(a)'])
    const caseSpan = spans.find((s) => s.name === SPAN_NAME_CASE)
    expect(caseSpan?.events.some((event) => event.attributes?.['exception.message'] === 'prepare boom')).toBe(true)
  })
})

describe('retry support via p-retry', () => {
  it('retries the task up to retries+1 times and recovers if it eventually succeeds', async () => {
    let attempts = 0
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'flaky' })],
      name: 'retry-test',
    })
    const { result } = await withMemoryExporter(async () =>
      ds.evaluate(
        () => {
          attempts++
          if (attempts < 3) {
            throw new Error('still flaky')
          }
          return 'OK'
        },
        { retryTask: { factor: 1, minTimeout: 1, retries: 5 } }
      )
    )
    expect(attempts).toBe(3)
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]?.output).toBe('OK')
    expect(result.failures).toHaveLength(0)
  })

  it('records a failure if the task keeps failing after retries are exhausted', async () => {
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'always-flaky' })],
      name: 'retry-failed',
    })
    const { result } = await withMemoryExporter(async () =>
      ds.evaluate(
        () => {
          throw new Error('persistent')
        },
        { retryTask: { factor: 1, minTimeout: 1, retries: 2 } }
      )
    )
    expect(result.failures).toHaveLength(1)
  })

  it('retries evaluators and records failure after evaluator retries are exhausted', async () => {
    class FlakyEvaluator extends Evaluator {
      static override evaluatorName = 'FlakyEvaluator'
      attempts = 0

      evaluate(): boolean {
        this.attempts += 1
        if (this.attempts < 3) {
          throw new Error('not yet')
        }
        return true
      }
    }

    const flaky = new FlakyEvaluator()
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'recovers' })],
      evaluators: [flaky],
      name: 'retry-evaluator',
    })
    const { result } = await withMemoryExporter(async () =>
      ds.evaluate((input) => input, { retryEvaluators: { factor: 1, minTimeout: 1, retries: 5 } })
    )

    expect(flaky.attempts).toBe(3)
    expect(result.cases[0]?.assertions['FlakyEvaluator']?.value).toBe(true)
    expect(result.cases[0]?.evaluator_failures).toEqual([])

    class AlwaysThrowsEvaluator extends Evaluator {
      static override evaluatorName = 'AlwaysThrowsEvaluator'
      attempts = 0

      evaluate(): never {
        this.attempts += 1
        throw new Error('persistent evaluator')
      }
    }

    const alwaysThrows = new AlwaysThrowsEvaluator()
    const failing = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'fails' })],
      evaluators: [alwaysThrows],
      name: 'retry-evaluator-failure',
    })
    const failed = await withMemoryExporter(async () =>
      failing.evaluate((input) => input, { retryEvaluators: { factor: 1, minTimeout: 1, retries: 2 } })
    )

    expect(alwaysThrows.attempts).toBe(3)
    expect(failed.result.cases[0]?.evaluator_failures).toMatchObject([
      { error_message: 'persistent evaluator', error_type: 'Error', name: 'AlwaysThrowsEvaluator' },
    ])
  })
})

describe('evaluate options validation', () => {
  it('rejects non-positive maxConcurrency before starting the experiment', async () => {
    const ds = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'a' })],
      name: 'invalid-concurrency-test',
    })

    await expect(ds.evaluate((input) => input, { maxConcurrency: 0 })).rejects.toThrow(
      'Dataset.evaluate: maxConcurrency must be a positive integer (got 0)'
    )
  })
})

describe('report-level evaluators land on the experiment span', () => {
  it('ConfusionMatrixEvaluator emits Python-compatible matrix rows=expected columns=predicted', async () => {
    const dataset = new Dataset<{ x: string }, string>({
      cases: [
        new Case<{ x: string }, string>({ expectedOutput: 'A', inputs: { x: 'A' }, name: '1' }),
        new Case<{ x: string }, string>({ expectedOutput: 'A', inputs: { x: 'B' }, name: '2' }),
        new Case<{ x: string }, string>({ expectedOutput: 'B', inputs: { x: 'A' }, name: '3' }),
      ],
      name: 'confusion-matrix-test',
      reportEvaluators: [new ConfusionMatrixEvaluator({ expected: { from: 'expected_output' }, predicted: { from: 'output' } })],
    })

    const { result, spans } = await withMemoryExporter(async () => dataset.evaluate(({ x }) => x))

    expect(result.analyses).toHaveLength(1)
    expect(result.analyses[0]).toEqual({
      class_labels: ['A', 'B'],
      matrix: [
        [1, 1],
        [1, 0],
      ],
      title: 'Confusion Matrix',
      type: 'confusion_matrix',
    })

    // Analyses MUST be on the experiment span as a JSON-encoded array.
    const experimentSpan = spans.find((s) => s.name === SPAN_NAME_EXPERIMENT)!
    const analysesAttr = experimentSpan.attributes[EXPERIMENT_ANALYSES_KEY]
    expect(typeof analysesAttr).toBe('string')
    expect(JSON.parse(analysesAttr as string)).toEqual(result.analyses)
  })

  it('awaits async report evaluator return values', async () => {
    class AsyncReportEvaluator extends ReportEvaluator<string, string> {
      static override evaluatorName = 'AsyncReportEvaluator'

      async evaluate(): Promise<{ title: string; type: 'scalar'; value: number }> {
        await sleep(1)
        return { title: 'Async Result', type: 'scalar', value: 42 }
      }
    }

    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'x', name: 'x' })],
      name: 'async-report-eval',
      reportEvaluators: [new AsyncReportEvaluator()],
    })

    const { result } = await withMemoryExporter(async () => dataset.evaluate((s) => s))
    expect(result.analyses).toEqual([{ title: 'Async Result', type: 'scalar', value: 42 }])
  })

  it("ConfusionMatrixEvaluator with from='labels' requires a key", () => {
    const evaluator = new ConfusionMatrixEvaluator({
      expected: { from: 'expected_output' },
      predicted: { from: 'labels' },
    })
    const report: EvaluationReport = {
      analyses: [],
      cases: [makeReportCase({ expected_output: 'A', labels: {} })],
      failures: [],
      name: 'matrix-needs-key',
      report_evaluator_failures: [],
      span_id: null,
      trace_id: null,
    }
    expect(() => evaluator.evaluate({ cases: report.cases, name: report.name, report })).toThrow("'key' is required when from='labels'")
  })

  it('passes the experiment name and full report to report evaluators', async () => {
    let captured: ReportEvaluatorContext<{ x: string }, string> | undefined
    class CaptureReportEvaluator extends ReportEvaluator<{ x: string }, string> {
      static override evaluatorName = 'CaptureReportEvaluator'

      evaluate(ctx: ReportEvaluatorContext<{ x: string }, string>) {
        captured = ctx
        return { columns: ['name'], rows: [[ctx.name]], title: 'captured', type: 'table' as const }
      }
    }

    const dataset = new Dataset<{ x: string }, string>({
      cases: [new Case<{ x: string }, string>({ expectedOutput: 'A', inputs: { x: 'A' }, name: '1' })],
      name: 'report-context-test',
      reportEvaluators: [new CaptureReportEvaluator()],
    })

    const { result } = await withMemoryExporter(async () =>
      dataset.evaluate(({ x }) => x, { metadata: { owner: 'evals' }, name: 'experiment-name' })
    )

    expect(captured?.name).toBe('experiment-name')
    expect(captured?.experimentMetadata).toEqual({ owner: 'evals' })
    expect(captured?.report).toBe(result)
    expect(captured?.report.cases[0]?.name).toBe('1')
  })

  it('records report evaluator failures and serializes them onto the experiment span', async () => {
    class BrokenReportEvaluator extends ReportEvaluator<string, string> {
      static override evaluatorName = 'BrokenReportEvaluator'
      override evaluatorVersion = 'v1'

      evaluate(): never {
        throw new Error('report boom')
      }
    }

    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'x', name: 'x' })],
      name: 'report-failure-test',
      reportEvaluators: [new BrokenReportEvaluator()],
    })

    const { result, spans } = await withMemoryExporter(async () => dataset.evaluate((input) => input))

    expect(result.report_evaluator_failures).toMatchObject([
      {
        error_message: 'report boom',
        error_type: 'Error',
        name: 'BrokenReportEvaluator',
        source: { arguments: null, name: 'BrokenReportEvaluator' },
      },
    ])
    const experimentSpan = spans.find((s) => s.name === SPAN_NAME_EXPERIMENT)!
    const failuresAttr = JSON.parse(experimentSpan.attributes[EXPERIMENT_REPORT_EVALUATOR_FAILURES_KEY] as string) as unknown[]
    expect(failuresAttr).toMatchObject([
      {
        error_message: 'report boom',
        error_type: 'Error',
        name: 'BrokenReportEvaluator',
        source: { arguments: null, name: 'BrokenReportEvaluator' },
      },
    ])
  })

  it('PrecisionRecall + ROCAUC + KS emit Python-compatible analysis shapes', async () => {
    const dataset = new Dataset<{ score: number }, number>({
      cases: [
        new Case<{ score: number }, number>({ expectedOutput: 1, inputs: { score: 0.9 }, name: '1' }),
        new Case<{ score: number }, number>({ expectedOutput: 0, inputs: { score: 0.1 }, name: '2' }),
        new Case<{ score: number }, number>({ expectedOutput: 1, inputs: { score: 0.6 }, name: '3' }),
        new Case<{ score: number }, number>({ expectedOutput: 0, inputs: { score: 0.3 }, name: '4' }),
      ],
      evaluators: [new Equals({ evaluationName: 'predicted', value: 0 })],
      name: 'thresholds-test',
      reportEvaluators: [
        new PrecisionRecallEvaluator({ positiveFrom: 'expected_output', scoreFrom: 'metrics', scoreKey: 'pred' }),
        new ROCAUCEvaluator({ positiveFrom: 'expected_output', scoreFrom: 'metrics', scoreKey: 'pred' }),
        new KolmogorovSmirnovEvaluator({ positiveFrom: 'expected_output', scoreFrom: 'metrics', scoreKey: 'pred' }),
      ],
    })

    // Encode the score into a metric so the report evaluators can see it.
    const { result } = await withMemoryExporter(async () =>
      dataset.evaluate(
        async (inputs) => {
          const { incrementEvalMetric } = await import('../../evals')
          incrementEvalMetric('pred', inputs.score)
          return inputs.score >= 0.5 ? 1 : 0
        },
        { name: 'thresholds-test' }
      )
    )

    // Each of PR / ROC / KS contributes 2 analyses (curve + scalar AUC/KS).
    expect(result.analyses).toHaveLength(6)
    expect(result.analyses).toEqual([
      {
        curves: [
          {
            auc: 1,
            name: 'thresholds-test',
            points: [
              { precision: 1, recall: 0, threshold: 0.9 },
              { precision: 1, recall: 0.5, threshold: 0.9 },
              { precision: 1, recall: 1, threshold: 0.6 },
              { precision: 2 / 3, recall: 1, threshold: 0.3 },
              { precision: 0.5, recall: 1, threshold: 0.1 },
            ],
          },
        ],
        title: 'Precision-Recall Curve',
        type: 'precision_recall',
      },
      { title: 'Precision-Recall Curve AUC', type: 'scalar', value: 1 },
      {
        curves: [
          {
            name: 'thresholds-test (AUC: 1.000)',
            points: [
              { x: 0, y: 0 },
              { x: 0, y: 0.5 },
              { x: 0, y: 1 },
              { x: 0.5, y: 1 },
              { x: 1, y: 1 },
            ],
            style: 'solid',
          },
          {
            name: 'Random',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
            style: 'dashed',
          },
        ],
        title: 'ROC Curve',
        type: 'line_plot',
        x_label: 'False Positive Rate',
        x_range: [0, 1],
        y_label: 'True Positive Rate',
        y_range: [0, 1],
      },
      { title: 'ROC Curve AUC', type: 'scalar', value: 1 },
      {
        curves: [
          {
            name: 'Positive',
            points: [
              { x: 0.1, y: 0 },
              { x: 0.1, y: 0 },
              { x: 0.3, y: 0 },
              { x: 0.6, y: 0.5 },
              { x: 0.9, y: 1 },
            ],
            step: 'end',
          },
          {
            name: 'Negative',
            points: [
              { x: 0.1, y: 0 },
              { x: 0.1, y: 0.5 },
              { x: 0.3, y: 1 },
              { x: 0.6, y: 1 },
              { x: 0.9, y: 1 },
            ],
            step: 'end',
          },
        ],
        title: 'KS Plot',
        type: 'line_plot',
        x_label: 'Score',
        y_label: 'Cumulative Probability',
        y_range: [0, 1],
      },
      { title: 'KS Statistic', type: 'scalar', value: 1 },
    ])
  })

  it('computes label averages as normalized frequencies', () => {
    const makeCase = (label: string): ReportCase => makeReportCase({ labels: { grade: resultJson('grade', label) }, name: label })

    expect(computeAverages('labels', [makeCase('good'), makeCase('good'), makeCase('bad')]).labels).toEqual({
      grade: { bad: 1 / 3, good: 2 / 3 },
    })
  })

  it('computes assertion pass rate plus score and metric means', () => {
    const cases = [
      makeReportCase({
        assertions: { ok: resultJson('ok', true) },
        metrics: { latency: 10 },
        scores: { quality: resultJson('quality', 0.5) },
        task_duration: 1,
        total_duration: 2,
      }),
      makeReportCase({
        assertions: { ok: resultJson('ok', false) },
        metrics: { latency: 20 },
        scores: { quality: resultJson('quality', 1) },
        task_duration: 3,
        total_duration: 4,
      }),
    ]

    expect(computeAssertionPassRate(cases)).toBe(0.5)
    expect(computeAssertionPassRate([makeReportCase()])).toBeNull()
    expect(computeAverages('means', cases)).toEqual({
      assertions: 0.5,
      labels: {},
      metrics: { latency: { count: 2, mean: 15 } },
      name: 'means',
      scores: { quality: { count: 2, mean: 0.75 } },
      task_duration: 2,
      total_duration: 3,
    })
    expect(computeAverages('empty', [])).toEqual({
      assertions: null,
      labels: {},
      metrics: {},
      name: 'empty',
      scores: {},
      task_duration: 0,
      total_duration: 0,
    })
  })
})

describe('report evaluator edge cases', () => {
  it('ReportEvaluator default getSpec uses the registry key and null arguments', () => {
    class MinimalReportEvaluator extends ReportEvaluator {
      static override evaluatorName = 'MinimalReportEvaluator'
      evaluate() {
        return { columns: [], rows: [], title: 'empty', type: 'table' as const }
      }
    }

    expect(new MinimalReportEvaluator().getSpec()).toEqual({ arguments: null, name: 'MinimalReportEvaluator' })
    expect(new MinimalReportEvaluator().toJSON()).toBeNull()
  })

  it('ConfusionMatrixEvaluator extracts labels and metadata and skips missing values', () => {
    const evaluator = new ConfusionMatrixEvaluator({
      expected: { from: 'metadata', key: 'expected' },
      predicted: { from: 'labels', key: 'predicted' },
      title: 'Custom Matrix',
    })
    const report: EvaluationReport = {
      analyses: [],
      cases: [
        makeReportCase({
          labels: { predicted: resultJson('predicted', 'B') },
          metadata: { expected: 'A' },
          name: 'a-to-b',
        }),
        makeReportCase({
          labels: { predicted: resultJson('predicted', 'A') },
          metadata: { expected: true },
          name: 'bool-to-a',
        }),
        makeReportCase({ labels: {}, metadata: { expected: 'A' }, name: 'missing-predicted' }),
      ],
      failures: [],
      name: 'matrix',
      report_evaluator_failures: [],
      span_id: null,
      trace_id: null,
    }

    expect(evaluator.evaluate({ cases: report.cases, name: 'matrix', report })).toEqual({
      class_labels: ['A', 'B', 'true'],
      matrix: [
        [0, 1, 0],
        [0, 0, 0],
        [1, 0, 0],
      ],
      title: 'Custom Matrix',
      type: 'confusion_matrix',
    })
    expect(evaluator.toJSON()).toEqual({
      expected_from: 'metadata',
      expected_key: 'expected',
      predicted_from: 'labels',
      predicted_key: 'predicted',
      title: 'Custom Matrix',
    })
  })

  it('threshold helpers support all sources, downsampling and empty AUC', () => {
    const cases = [
      makeReportCase({
        assertions: { positive: resultJson('positive', true) },
        expected_output: { positive: false },
        labels: { positive: resultJson('positive', 'yes') },
        metrics: { m: 0.8 },
        scores: { s: resultJson('s', 0.7) },
      }),
      makeReportCase({
        assertions: { positive: resultJson('positive', false) },
        expected_output: { positive: true },
        labels: { positive: resultJson('positive', '') },
        metrics: { m: 0.2 },
        scores: { s: resultJson('s', 0.1) },
      }),
      makeReportCase({ metrics: {}, scores: {} }),
    ]

    expect(
      buildThresholdInputs(cases, { positiveFrom: 'assertions', positiveKey: 'positive', scoreFrom: 'scores', scoreKey: 's' })
    ).toEqual({
      positives: [true, false],
      scores: [0.7, 0.1],
    })
    expect(() =>
      buildThresholdInputs(cases, { positiveFrom: 'expected_output', positiveKey: 'positive', scoreFrom: 'metrics', scoreKey: 'm' })
    ).toThrow("'positiveKey' is not supported when positiveFrom='expected_output'")
    expect(buildThresholdInputs(cases, { positiveFrom: 'labels', positiveKey: 'positive', scoreFrom: 'scores', scoreKey: 's' })).toEqual({
      positives: [true, false],
      scores: [0.7, 0.1],
    })
    expect(buildThresholdInputs(cases, { positiveFrom: 'expected_output', scoreFrom: 'scores', scoreKey: 's' })).toEqual({
      positives: [true, true],
      scores: [0.7, 0.1],
    })
    expect(() => buildThresholdInputs(cases, { positiveFrom: 'assertions', scoreFrom: 'scores', scoreKey: 's' })).toThrow(
      "'positiveKey' is required when positiveFrom='assertions'"
    )
    expect(uniqueSortedThresholds([], 3)).toEqual([])
    expect(uniqueSortedThresholds([3, 2, 1, 0], 2)).toEqual([3, 0])
    expect(uniqueSortedThresholds([3, 2, 1], 1)).toEqual([3, 2, 1])
    expect(uniqueSortedThresholds([3, 2, 1], 0)).toEqual([3, 2, 1])
    expect(trapezoidalAuc([0], [1])).toBe(0)
    expect(trapezoidalAuc([0, 0.5, 1], [0, 1, 1])).toBe(0.75)
  })

  it('computes PR/ROC AUC at full resolution before downsampling display points', () => {
    const report: EvaluationReport = {
      analyses: [],
      cases: [
        makeReportCase({ assertions: { p: resultJson('p', true) }, name: 'a', scores: { s: resultJson('s', 0.9) } }),
        makeReportCase({ assertions: { p: resultJson('p', false) }, name: 'b', scores: { s: resultJson('s', 0.8) } }),
        makeReportCase({ assertions: { p: resultJson('p', true) }, name: 'c', scores: { s: resultJson('s', 0.7) } }),
        makeReportCase({ assertions: { p: resultJson('p', false) }, name: 'd', scores: { s: resultJson('s', 0.6) } }),
      ],
      failures: [],
      name: 'full-resolution',
      report_evaluator_failures: [],
      span_id: null,
      trace_id: null,
    }
    const ctx = { cases: report.cases, name: report.name, report }
    const pr = new PrecisionRecallEvaluator({ nThresholds: 2, positiveFrom: 'assertions', positiveKey: 'p', scoreKey: 's' })
    const roc = new ROCAUCEvaluator({ nThresholds: 2, positiveFrom: 'assertions', positiveKey: 'p', scoreKey: 's' })
    const ks = new KolmogorovSmirnovEvaluator({ nThresholds: 2, positiveFrom: 'assertions', positiveKey: 'p', scoreKey: 's' })

    expect(pr.evaluate(ctx)[0].curves[0]?.points).toHaveLength(2)
    expect(pr.evaluate(ctx)[1].value).toBeCloseTo(19 / 24)
    expect(roc.evaluate(ctx)[0].curves[0]?.points).toHaveLength(2)
    expect(roc.evaluate(ctx)[1].value).toBe(0.75)
    expect(ks.evaluate(ctx)[0].curves[0]?.points).toHaveLength(2)
  })

  it('threshold report evaluators return empty/NaN analyses and custom specs when inputs are absent', () => {
    const report: EvaluationReport = {
      analyses: [],
      cases: [makeReportCase()],
      failures: [],
      name: 'empty-thresholds',
      report_evaluator_failures: [],
      span_id: null,
      trace_id: null,
    }
    const ctx = { cases: report.cases, name: report.name, report }
    const pr = new PrecisionRecallEvaluator({
      nThresholds: 5,
      positiveFrom: 'assertions',
      positiveKey: 'ok',
      scoreFrom: 'scores',
      scoreKey: 'score',
      title: 'Custom PR',
    })
    const roc = new ROCAUCEvaluator({
      nThresholds: 5,
      positiveFrom: 'labels',
      positiveKey: 'grade',
      scoreFrom: 'metrics',
      scoreKey: 'score',
      title: 'Custom ROC',
    })
    const ks = new KolmogorovSmirnovEvaluator({
      positiveFrom: 'expected_output',
      scoreFrom: 'scores',
      scoreKey: 'score',
      title: 'Custom KS',
    })

    expect(pr.evaluate(ctx)[0]).toEqual({ curves: [], title: 'Custom PR', type: 'precision_recall' })
    expect(Number.isNaN(pr.evaluate(ctx)[1].value)).toBe(true)
    expect(Number.isNaN(roc.evaluate(ctx)[1].value)).toBe(true)
    expect(Number.isNaN(ks.evaluate(ctx)[1].value)).toBe(true)
    expect(pr.toJSON()).toEqual({
      n_thresholds: 5,
      positive_from: 'assertions',
      positive_key: 'ok',
      score_key: 'score',
      title: 'Custom PR',
    })
    expect(roc.toJSON()).toEqual({
      n_thresholds: 5,
      positive_from: 'labels',
      positive_key: 'grade',
      score_from: 'metrics',
      score_key: 'score',
      title: 'Custom ROC',
    })
    expect(ks.toJSON()).toEqual({
      positive_from: 'expected_output',
      score_key: 'score',
      title: 'Custom KS',
    })
  })
})

describe('renderReport', () => {
  it('renders a compact ascii table with the headline counts', () => {
    const report: EvaluationReport = {
      analyses: [],
      cases: [
        {
          assertions: { ok: { name: 'ok', reason: null, source: { arguments: null, name: 'X' }, value: true } },
          attributes: {},
          evaluator_failures: [],
          inputs: 'a',
          labels: {},
          metrics: {},
          name: 'one',
          output: 'A',
          scores: {},
          span_id: 's',
          task_duration: 0.01,
          total_duration: 0.02,
          trace_id: 't',
        },
      ],
      failures: [],
      name: 'demo',
      report_evaluator_failures: [],
      span_id: 's',
      trace_id: 't',
    }
    const text = renderReport(report)
    expect(text).toContain('Experiment: demo')
    expect(text).toContain('Cases: 1')
    expect(text).toContain('one')
    expect(text).toContain('ok=✓')
  })

  it('renders optional inputs, outputs, failures, analyses and scalar formatting', () => {
    const report: EvaluationReport = {
      analyses: [{ title: 'Quality', type: 'scalar', value: 0.95 }],
      cases: [
        makeReportCase({
          assertions: { bad: resultJson('bad', false) },
          inputs: { prompt: 'a very long prompt that should be truncated in the table' },
          labels: { grade: resultJson('grade', 'good') },
          output: { answer: 'a very long answer that should be truncated in the table' },
          scores: { quality: resultJson('quality', 0.75) },
        }),
      ],
      failures: [
        {
          error_message: 'boom',
          error_type: 'Error',
          inputs: 'bad',
          name: 'failed',
          span_id: null,
          trace_id: null,
        },
      ],
      name: 'render-full',
      report_evaluator_failures: [],
      span_id: null,
      trace_id: null,
    }

    const text = renderReport(report, { includeInput: true, includeOutput: true })
    expect(text).toContain('input')
    expect(text).toContain('output')
    expect(text).toContain('quality=0.75')
    expect(text).toContain('grade=good')
    expect(text).toContain('bad=✗')
    expect(text).toContain('Failures:')
    expect(text).toContain('failed: Error: boom')
    expect(text).toContain('Analyses: 1')
    expect(text).toContain('Quality (scalar)')
    expect(text).toContain('…')

    expect(renderReport(report, { includeFailures: false })).not.toContain('\nFailures:\n')
  })
})
