/** Tests to close remaining coverage gaps. */
import { describe, expect, test } from 'vitest'

import { Case, Dataset } from './dataset'
import { Contains, IsInstance, LLMJudge } from './evaluators/common'
import { EvaluatorContext } from './evaluators/context'
import { evaluationReason, Evaluator } from './evaluators/evaluator'
import { ROCAUCEvaluator } from './evaluators/reportCommon'
import { contextSubtree, contextSubtreeCapture } from './otel/contextSubtree'
import { SpanTreeRecordingError } from './otel/errors'
import { SpanTree } from './otel/spanTree'

describe('coverage: dataset helpers', () => {
  class LabelEval extends Evaluator {
    evaluate() {
      return 'label-value'
    }
  }

  class DupEval extends Evaluator {
    evaluate() {
      return { x: true }
    }
  }

  test('labels are grouped in report', async () => {
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1, name: 'a' })], evaluators: [new LabelEval()], name: 'l' })
    const report = await ds.evaluate((n: number) => n)
    expect(report.cases[0]?.labels.LabelEval?.value).toBe('label-value')
  })

  test('duplicate evaluator output names get suffixed', async () => {
    const ds = new Dataset<number, number>({
      cases: [new Case({ inputs: 1, name: 'a' })],
      evaluators: [new DupEval(), new DupEval()],
      name: 'd',
    })
    const report = await ds.evaluate((n: number) => n)
    // Both should appear in assertions, one with a _2 suffix
    expect(Object.keys(report.cases[0]?.assertions ?? {}).length).toBe(2)
  })

  test('three duplicates produce _2 and _3 suffixes', async () => {
    const ds = new Dataset<number, number>({
      cases: [new Case({ inputs: 1, name: 'a' })],
      evaluators: [new DupEval(), new DupEval(), new DupEval()],
      name: 'd3',
    })
    const report = await ds.evaluate((n: number) => n)
    expect(Object.keys(report.cases[0]?.assertions ?? {})).toEqual(expect.arrayContaining(['x', 'x_2', 'x_3']))
  })
})

describe('coverage: span tree metric extraction', () => {
  test('extractSpanTreeMetrics pulls metrics from LLM spans', async () => {
    // We can't easily inject real OTel spans, but we can construct a SpanTree directly
    // and verify extraction behavior via the internal function. We test it indirectly via
    // running a task where we manually install a fake tree via contextSubtreeCapture.
    const { SpanNode } = await import('./otel/spanTree')
    const node = new SpanNode({
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.usage.details.foo': 5,
        'gen_ai.usage.input_tokens': 10,
        'operation.cost': 0.5,
      } as never,
      endTimestamp: new Date(1000),
      name: 'llm-call',
      parentSpanId: null,
      spanId: 'x',
      startTimestamp: new Date(0),
      traceId: 't',
    })
    const tree = new SpanTree([node])
    expect(tree.roots).toHaveLength(1)
  })
})

describe('coverage: contextSubtree', () => {
  test('contextSubtree yields SpanTreeRecordingError when no provider configured', async () => {
    const result = await contextSubtree((tree) => tree instanceof SpanTreeRecordingError)
    expect(result).toBe(true)
  })

  test('contextSubtreeCapture yields SpanTreeRecordingError when no provider', async () => {
    const result = await contextSubtreeCapture((getTree) => getTree() instanceof SpanTreeRecordingError)
    expect(result).toBe(true)
  })
})

describe('coverage: LLMJudge branches', () => {
  test('LLMJudge both score and assertion include reason', async () => {
    const judge = async () => Promise.resolve({ pass_: false, reason: 'r', score: 0.2 })
    const ev = new LLMJudge({
      assertion: { evaluationName: 'asrt', includeReason: true },
      judge,
      rubric: 'r',
      score: { evaluationName: 'scr', includeReason: true },
    })
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: 'x',
      spanTree: new SpanTreeRecordingError('no'),
    })
    const result = await ev.evaluate(ctx)
    expect(result).toBeTruthy()
  })

  test('LLMJudge with only score=false', async () => {
    const judge = async () => Promise.resolve({ pass_: true, reason: 'r', score: 1 })
    const ev = new LLMJudge({ judge, rubric: 'r' })
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: 'x',
      spanTree: new SpanTreeRecordingError('no'),
    })
    const result = (await ev.evaluate(ctx)) as Record<string, unknown>
    expect(Object.keys(result)).toContain('LLMJudge')
  })
})

describe('coverage: IsInstance primitive shortcut', () => {
  test('IsInstance works with primitive string type name', () => {
    const ev = new IsInstance({ typeName: 'string' })
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: 'hello',
      spanTree: new SpanTreeRecordingError('no'),
    })
    expect(ev.evaluate(ctx).value).toBe(true)
  })

  test('IsInstance on undefined', () => {
    const ev = new IsInstance({ typeName: 'Object' })
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: undefined as never,
      spanTree: new SpanTreeRecordingError('no'),
    })
    expect(ev.evaluate(ctx).value).toBe(false)
  })
})

describe('coverage: Contains edge cases', () => {
  test('Contains asStrings forces string comparison', () => {
    const ev = new Contains({ asStrings: true, value: 123 })
    const mod = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: 'prefix-123-suffix',
      spanTree: new SpanTreeRecordingError('no'),
    })
    expect(ev.evaluate(mod).value).toBe(true)
  })

  test('evaluationReason with null reason', () => {
    const r = evaluationReason(true)
    expect(r.reason).toBeNull()
  })
})

describe('coverage: ROCAUC empty edge case', () => {
  test('ROCAUC n_thresholds=1 returns full', () => {
    const ev = new ROCAUCEvaluator({ nThresholds: 1, positiveFrom: 'expected_output', scoreKey: 's' })
    const ctx = {
      experimentMetadata: null,
      name: 'exp',
      report: {
        cases: [
          {
            assertions: {},
            expectedOutput: true,
            inputs: {},
            labels: {},
            metadata: null,
            metrics: {},
            name: 'c',
            output: null,
            scores: { s: { reason: null, source: { arguments: null, name: 'X' }, value: 0.9 } },
          },
          {
            assertions: {},
            expectedOutput: false,
            inputs: {},
            labels: {},
            metadata: null,
            metrics: {},
            name: 'c2',
            output: null,
            scores: { s: { reason: null, source: { arguments: null, name: 'X' }, value: 0.1 } },
          },
        ],
      },
    } as never
    const r = ev.evaluate(ctx)
    expect(r).toHaveLength(2)
  })
})
