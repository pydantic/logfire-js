/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'

import {
  Case,
  CaseLifecycle,
  ConfusionMatrixEvaluator,
  Dataset,
  Equals,
  EqualsExpected,
  type EvaluationReport,
  type EvaluatorContext,
  EXPERIMENT_ANALYSES_KEY,
  KolmogorovSmirnovEvaluator,
  PrecisionRecallEvaluator,
  renderReport,
  type ReportCase,
  type ReportCaseFailure,
  ROCAUCEvaluator,
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
})

describe('report-level evaluators land on the experiment span', () => {
  it('ConfusionMatrixEvaluator analyses end up under logfire.experiment.analyses', async () => {
    const dataset = new Dataset<{ x: string }, string>({
      cases: [
        new Case<{ x: string }, string>({ expectedOutput: 'A', inputs: { x: 'A' }, name: '1' }),
        new Case<{ x: string }, string>({ expectedOutput: 'A', inputs: { x: 'A' }, name: '2' }),
        new Case<{ x: string }, string>({ expectedOutput: 'B', inputs: { x: 'B' }, name: '3' }),
      ],
      name: 'confusion-matrix-test',
      reportEvaluators: [new ConfusionMatrixEvaluator({ expected: { from: 'expected_output' }, predicted: { from: 'output' } })],
    })

    const { result, spans } = await withMemoryExporter(async () => dataset.evaluate(({ x }) => x))

    expect(result.analyses).toHaveLength(1)
    expect(result.analyses[0]?.type).toBe('confusion_matrix')
    const cm = result.analyses[0] as { matrix: Record<string, Record<string, number>> }
    expect(cm.matrix.A?.A).toBe(2)
    expect(cm.matrix.B?.B).toBe(1)

    // Analyses MUST be on the experiment span as a JSON-encoded array.
    const experimentSpan = spans.find((s) => s.name === SPAN_NAME_EXPERIMENT)!
    const analysesAttr = experimentSpan.attributes[EXPERIMENT_ANALYSES_KEY]
    expect(typeof analysesAttr).toBe('string')
    const parsed = JSON.parse(analysesAttr as string) as { type: string }[]
    expect(parsed[0]?.type).toBe('confusion_matrix')
  })

  it('PrecisionRecall + ROCAUC + KS produce paired analysis arrays', async () => {
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
    const types = result.analyses.map((a) => a.type)
    expect(types).toContain('precision_recall')
    expect(types).toContain('roc_curve')
    expect(types).toContain('ks')
    expect(types.filter((t) => t === 'scalar')).toHaveLength(3)
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
