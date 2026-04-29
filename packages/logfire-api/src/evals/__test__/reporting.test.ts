/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'

import {
  Case,
  CaseLifecycle,
  computeAverages,
  ConfusionMatrixEvaluator,
  Dataset,
  Equals,
  EqualsExpected,
  type EvaluationReport,
  Evaluator,
  type EvaluatorContext,
  EXPERIMENT_ANALYSES_KEY,
  KolmogorovSmirnovEvaluator,
  PrecisionRecallEvaluator,
  renderReport,
  type ReportCase,
  type ReportCaseFailure,
  ReportEvaluator,
  type ReportEvaluatorContext,
  ROCAUCEvaluator,
  SPAN_NAME_CASE,
  SPAN_NAME_EXPERIMENT,
} from '../../evals'
import { withMemoryExporter } from './withMemoryExporter'

describe('lifecycle hooks', () => {
  it('runs setup → task → prepareContext → evaluators → teardown in order', async () => {
    const order: string[] = []

    class TraceLifecycle extends CaseLifecycle<string, string> {
      prepareContext(ctx: EvaluatorContext<string, string>): EvaluatorContext<string, string> {
        order.push('prepareContext')
        return ctx
      }
      async setup(): Promise<void> {
        order.push('setup')
      }
      async teardown(_result: ReportCase<string, string> | ReportCaseFailure<string, string>): Promise<void> {
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
      async teardown(): Promise<void> {
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
      async teardown(): Promise<void> {
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
      async teardown(): Promise<void> {
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
          if (attempts < 3) throw new Error('still flaky')
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
      static evaluatorName = 'FlakyEvaluator'
      attempts = 0

      evaluate(): boolean {
        this.attempts += 1
        if (this.attempts < 3) throw new Error('not yet')
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
    expect(result.cases[0]?.assertions.FlakyEvaluator?.value).toBe(true)
    expect(result.cases[0]?.evaluator_failures).toEqual([])

    class AlwaysThrowsEvaluator extends Evaluator {
      static evaluatorName = 'AlwaysThrowsEvaluator'
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

  it('passes the experiment name and full report to report evaluators', async () => {
    let captured: ReportEvaluatorContext<{ x: string }, string> | undefined
    class CaptureReportEvaluator extends ReportEvaluator<{ x: string }, string> {
      static evaluatorName = 'CaptureReportEvaluator'

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
      dataset.evaluate(async (inputs) => {
        const { incrementEvalMetric } = await import('../../evals')
        incrementEvalMetric('pred', inputs.score)
        return inputs.score >= 0.5 ? 1 : 0
      })
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
        title: 'Precision–Recall',
        type: 'precision_recall',
      },
      { title: 'Precision–Recall AUC', type: 'scalar', value: 1 },
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
              { x: 0.3, y: 0 },
              { x: 0.6, y: 0.5 },
              { x: 0.9, y: 1 },
            ],
            step: 'end',
          },
          {
            name: 'Negative',
            points: [
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
    const makeCase = (label: string): ReportCase => ({
      assertions: {},
      attributes: {},
      evaluator_failures: [],
      inputs: 'x',
      labels: { grade: { name: 'grade', reason: null, source: { arguments: null, name: 'Labeler' }, value: label } },
      metrics: {},
      name: label,
      output: 'x',
      scores: {},
      span_id: null,
      task_duration: 0,
      total_duration: 0,
      trace_id: null,
    })

    expect(computeAverages('labels', [makeCase('good'), makeCase('good'), makeCase('bad')]).labels).toEqual({
      grade: { bad: 1 / 3, good: 2 / 3 },
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
      experiment_metadata: undefined,
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
})
