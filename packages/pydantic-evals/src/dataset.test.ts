import { describe, expect, test } from 'vitest'

import { Case, Dataset, getCurrentTaskRun, incrementEvalMetric, setEvalAttribute } from './dataset'
import {
  Contains,
  Equals,
  EqualsExpected,
  HasMatchingSpan,
  IsInstance,
  LLMJudge,
  MaxDuration,
  setDefaultJudgeFn,
} from './evaluators/common'
import { EvaluatorContext } from './evaluators/context'
import { Evaluator } from './evaluators/evaluator'
import { ConfusionMatrixEvaluator } from './evaluators/reportCommon'
import { ReportEvaluator, ReportEvaluatorContext } from './evaluators/reportEvaluator'
import { CaseLifecycle } from './lifecycle'
import { SpanTreeRecordingError } from './otel/errors'
import { ReportAnalysis } from './reporting/analyses'

class ExactMatch extends Evaluator {
  evaluate(ctx: EvaluatorContext): boolean {
    return ctx.output === ctx.expectedOutput
  }
}

describe('Case', () => {
  test('constructs with defaults', () => {
    const c = new Case({ inputs: 'hello' })
    expect(c.name).toBeNull()
    expect(c.inputs).toBe('hello')
    expect(c.metadata).toBeNull()
    expect(c.expectedOutput).toBeNull()
    expect(c.evaluators).toEqual([])
  })

  test('constructs with all fields', () => {
    const ev = new ExactMatch()
    const c = new Case({ evaluators: [ev], expectedOutput: 'world', inputs: 'hello', metadata: { note: 'x' }, name: 'test-case' })
    expect(c.name).toBe('test-case')
    expect(c.evaluators).toHaveLength(1)
  })
})

describe('Dataset basic', () => {
  test('rejects duplicate case names', () => {
    expect(
      () =>
        new Dataset({
          cases: [new Case({ inputs: 1, name: 'a' }), new Case({ inputs: 2, name: 'a' })],
          name: 'ds',
        })
    ).toThrow(/Duplicate case name/)
  })

  test('warns when name omitted but still works', () => {
    const ds = new Dataset({ cases: [new Case({ inputs: 1 })] })
    expect(ds.name).toBeNull()
  })

  test('addCase and addEvaluator', () => {
    const ds = new Dataset({ cases: [new Case({ inputs: 1, name: 'a' })], name: 'ds' })
    ds.addCase({ inputs: 2, name: 'b' })
    expect(ds.cases).toHaveLength(2)
    expect(() => {
      ds.addCase({ inputs: 3, name: 'a' })
    }).toThrow(/Duplicate case name/)
    ds.addEvaluator(new ExactMatch())
    expect(ds.evaluators).toHaveLength(1)
    ds.addEvaluator(new ExactMatch(), 'a')
    expect(ds.cases[0]?.evaluators).toHaveLength(1)
    expect(() => {
      ds.addEvaluator(new ExactMatch(), 'missing')
    }).toThrow(/not found/)
  })
})

describe('Dataset evaluate', () => {
  test('runs a synchronous task and produces a report', async () => {
    const ds = new Dataset<string, string>({
      cases: [
        new Case({ expectedOutput: 'HELLO', inputs: 'hello', name: 'test1' }),
        new Case({ expectedOutput: 'WORLD', inputs: 'world', name: 'test2' }),
      ],
      evaluators: [new ExactMatch()],
      name: 'upper',
    })
    const report = await ds.evaluate((s: string) => s.toUpperCase())
    expect(report.cases).toHaveLength(2)
    expect(report.failures).toHaveLength(0)
    expect(report.cases[0]?.assertions.ExactMatch?.value).toBe(true)
    expect(report.cases[1]?.assertions.ExactMatch?.value).toBe(true)
  })

  test('captures failures', async () => {
    const ds = new Dataset({ cases: [new Case({ inputs: 1, name: 'boom' })], name: 'fail' })
    const report = await ds.evaluate((): never => {
      throw new Error('kaboom')
    })
    expect(report.cases).toHaveLength(0)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]?.errorMessage).toContain('kaboom')
  })

  test('supports async tasks and max concurrency', async () => {
    const ds = new Dataset<number, number>({
      cases: [new Case({ inputs: 1, name: 'a' }), new Case({ inputs: 2, name: 'b' }), new Case({ inputs: 3, name: 'c' })],
      name: 'async',
    })
    const report = await ds.evaluate(async (n: number) => await Promise.resolve(n * 2), { maxConcurrency: 2 })
    expect(report.cases).toHaveLength(3)
    expect(report.cases.map((c) => c.output).sort((a, b) => a - b)).toEqual([2, 4, 6])
  })

  test('repeat > 1 produces grouped report', async () => {
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1, name: 'a' })], evaluators: [new ExactMatch()], name: 'rep' })
    const report = await ds.evaluate((n: number) => n, { repeat: 3 })
    expect(report.cases).toHaveLength(3)
    const groups = report.caseGroups()!
    expect(groups).toHaveLength(1)
    expect(groups[0]?.runs).toHaveLength(3)
    expect(report.averages()).not.toBeNull()
  })

  test('repeat < 1 throws', async () => {
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1 })], name: 'rep' })
    await expect(ds.evaluate((n: number) => n, { repeat: 0 })).rejects.toThrow(/repeat must be/)
  })

  test('lifecycle hooks fire', async () => {
    const events: string[] = []
    class Lc extends CaseLifecycle {
      async prepareContext(ctx: EvaluatorContext) {
        events.push('prepare')
        return await Promise.resolve(ctx)
      }

      async setup() {
        events.push('setup')
        await Promise.resolve()
      }

      async teardown() {
        events.push('teardown')
        await Promise.resolve()
      }
    }
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1, name: 'a' })], name: 'lc' })
    await ds.evaluate((n: number) => n, { lifecycle: Lc as never })
    expect(events).toEqual(['setup', 'prepare', 'teardown'])
  })

  test('metadata passed through', async () => {
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1, name: 'a' })], name: 'm' })
    const report = await ds.evaluate((n: number) => n, { metadata: { env: 'test' } })
    expect(report.experimentMetadata).toEqual({ env: 'test' })
  })

  test('setEvalAttribute and incrementEvalMetric capture data during task', async () => {
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1, name: 'a' })], name: 'm' })
    const report = await ds.evaluate((n: number) => {
      setEvalAttribute('user_id', 'u1')
      incrementEvalMetric('items_processed', 2)
      incrementEvalMetric('items_processed', 3)
      return n
    })
    expect(report.cases[0]?.attributes.user_id).toBe('u1')
    expect(report.cases[0]?.metrics.items_processed).toBe(5)
  })

  test('getCurrentTaskRun returns null outside of evaluation', () => {
    expect(getCurrentTaskRun()).toBeNull()
  })

  test('setEvalAttribute/incrementEvalMetric no-op outside evaluation', () => {
    // Should not throw
    setEvalAttribute('x', 1)
    incrementEvalMetric('y', 1)
  })
})

describe('Dataset serialization', () => {
  test('round-trips via JSON/YAML with evaluator specs', async () => {
    const ds = new Dataset({
      cases: [new Case({ evaluators: [new EqualsExpected()], expectedOutput: 'HI', inputs: 'hi', name: 'c1' })],
      evaluators: [new Equals({ value: 42 })],
      name: 'ds',
    })
    const json = await ds.toJSON()
    const parsed = Dataset.fromText(json, { fmt: 'json' })
    expect(parsed.name).toBe('ds')
    expect(parsed.cases).toHaveLength(1)
    expect(parsed.cases[0]?.evaluators).toHaveLength(1)
    expect(parsed.evaluators).toHaveLength(1)

    const yaml = await ds.toYAML()
    const fromYaml = Dataset.fromText(yaml)
    expect(fromYaml.cases).toHaveLength(1)
  })

  test('fromDict with default name', () => {
    const ds = Dataset.fromDict<string, string>({ cases: [{ inputs: 'hi' }] }, { defaultName: 'fallback' })
    expect(ds.name).toBe('fallback')
  })

  test('fromDict with custom evaluator types', () => {
    class CustomEval extends Evaluator {
      readonly threshold: number
      constructor(params: { threshold: number }) {
        super()
        this.threshold = params.threshold
      }
      evaluate() {
        return this.threshold > 0
      }
    }
    const ds = Dataset.fromDict(
      {
        cases: [{ evaluators: [{ CustomEval: { threshold: 3 } }], inputs: 1, name: 'x' }],
        name: 'ds',
      },
      { customEvaluatorTypes: [CustomEval] }
    )
    expect(ds.cases[0]?.evaluators).toHaveLength(1)
  })

  test('fromDict throws for unknown evaluator', () => {
    expect(() => Dataset.fromDict({ cases: [{ evaluators: ['MissingEval'], inputs: 1, name: 'x' }], name: 'ds' }, {})).toThrow(
      /Unknown evaluator/
    )
  })

  test('fromDict supports report_evaluators', () => {
    const ds = Dataset.fromDict({ cases: [{ inputs: 1 }], name: 'ds', report_evaluators: ['ConfusionMatrixEvaluator'] })
    expect(ds.reportEvaluators).toHaveLength(1)
  })
})

describe('LLMJudge + report evaluators integration', () => {
  test('LLMJudge invokes judge function and returns mapping', async () => {
    setDefaultJudgeFn(async () => Promise.resolve({ pass_: true, reason: 'ok', score: 0.9 }))
    const ds = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hi', name: 'c' })],
      evaluators: [new LLMJudge({ rubric: 'is nice', score: {} })],
      name: 'j',
    })
    const report = await ds.evaluate((s: string) => s)
    expect(report.cases[0]?.assertions.LLMJudge_pass?.value).toBe(true)
    expect(report.cases[0]?.scores.LLMJudge_score?.value).toBe(0.9)
    setDefaultJudgeFn(null)
  })

  test('LLMJudge with only score', async () => {
    const judge: Parameters<typeof setDefaultJudgeFn>[0] = async () => Promise.resolve({ pass_: true, reason: 'ok', score: 0.5 })
    const ds = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hi', name: 'c' })],
      evaluators: [new LLMJudge({ assertion: false, judge, rubric: 'score only', score: {} })],
      name: 'j',
    })
    const report = await ds.evaluate((s: string) => s)
    expect(report.cases[0]?.scores.LLMJudge?.value).toBe(0.5)
  })

  test('LLMJudge includes input and expected', async () => {
    const seen: { expectedOutput?: unknown; inputs?: unknown }[] = []
    const judge: Parameters<typeof setDefaultJudgeFn>[0] = async (params) => {
      seen.push({ expectedOutput: params.expectedOutput, inputs: params.inputs })
      return await Promise.resolve({ pass_: true, reason: null as unknown as string, score: 1 })
    }
    const ds = new Dataset<string, string>({
      cases: [new Case({ expectedOutput: 'EXP', inputs: 'hi', name: 'c' })],
      evaluators: [new LLMJudge({ includeExpectedOutput: true, includeInput: true, judge, rubric: 'r' })],
      name: 'j',
    })
    await ds.evaluate((s: string) => s)
    expect(seen[0]?.inputs).toBe('hi')
    expect(seen[0]?.expectedOutput).toBe('EXP')
  })

  test('LLMJudge fails when no judge is configured', async () => {
    const ds = new Dataset<string, string>({
      cases: [new Case({ inputs: 'hi', name: 'c' })],
      evaluators: [new LLMJudge({ rubric: 'no judge' })],
      name: 'j',
    })
    const report = await ds.evaluate((s: string) => s)
    expect(report.cases[0]?.evaluatorFailures).toHaveLength(1)
    expect(report.cases[0]?.evaluatorFailures[0]?.errorMessage).toContain('no `judge` function')
  })

  test('report evaluator is invoked and produces analyses', async () => {
    class MyReportEval extends ReportEvaluator {
      evaluate(): ReportAnalysis {
        return { title: 'count', type: 'scalar', value: 1 }
      }
    }
    const ds = new Dataset<number, number>({
      cases: [new Case({ inputs: 1, name: 'a' })],
      name: 'r',
      reportEvaluators: [new MyReportEval()],
    })
    const report = await ds.evaluate((n: number) => n)
    expect(report.analyses).toHaveLength(1)
  })

  test('report evaluator failure is recorded', async () => {
    class BadReportEval extends ReportEvaluator {
      evaluate(): ReportAnalysis {
        throw new Error('bad')
      }
    }
    const ds = new Dataset<number, number>({
      cases: [new Case({ inputs: 1, name: 'a' })],
      name: 'r',
      reportEvaluators: [new BadReportEval()],
    })
    const report = await ds.evaluate((n: number) => n)
    expect(report.reportEvaluatorFailures).toHaveLength(1)
  })

  test('report evaluator returning array extends analyses', async () => {
    class MultiEval extends ReportEvaluator {
      evaluate(): ReportAnalysis[] {
        return [
          { title: 'a', type: 'scalar', value: 1 },
          { title: 'b', type: 'scalar', value: 2 },
        ]
      }
    }
    const ds = new Dataset<number, number>({ cases: [new Case({ inputs: 1, name: 'a' })], name: 'r', reportEvaluators: [new MultiEval()] })
    const report = await ds.evaluate((n: number) => n)
    expect(report.analyses).toHaveLength(2)
  })
})

describe('common evaluators', () => {
  const makeCtx = (overrides: Partial<{ duration: number; expectedOutput: unknown; inputs: unknown; output: unknown }> = {}) =>
    new EvaluatorContext({
      attributes: {},
      duration: overrides.duration ?? 0,
      expectedOutput: overrides.expectedOutput ?? null,
      inputs: overrides.inputs ?? {},
      metadata: null,
      metrics: {},
      name: null,
      output: overrides.output,
      spanTree: new SpanTreeRecordingError('no'),
    })

  test('Equals matches equal values', () => {
    const ev = new Equals({ value: 42 })
    expect(ev.evaluate(makeCtx({ output: 42 }))).toBe(true)
    expect(ev.evaluate(makeCtx({ output: 0 }))).toBe(false)
  })

  test('EqualsExpected returns empty when expected absent', () => {
    const ev = new EqualsExpected()
    expect(ev.evaluate(makeCtx({ output: 1 }))).toEqual({})
    expect(ev.evaluate(makeCtx({ expectedOutput: 1, output: 1 }))).toBe(true)
    expect(ev.evaluate(makeCtx({ expectedOutput: 2, output: 1 }))).toBe(false)
  })

  test('Contains with strings', () => {
    const ev = new Contains({ value: 'hello' })
    const pass = ev.evaluate(makeCtx({ output: 'hello world' }))
    expect(pass.value).toBe(true)
    const fail = ev.evaluate(makeCtx({ output: 'goodbye' }))
    expect(fail.value).toBe(false)
  })

  test('Contains case-insensitive', () => {
    const ev = new Contains({ caseSensitive: false, value: 'HELLO' })
    const pass = ev.evaluate(makeCtx({ output: 'hello world' }))
    expect(pass.value).toBe(true)
  })

  test('Contains with arrays', () => {
    const ev = new Contains({ value: 2 })
    const pass = ev.evaluate(makeCtx({ output: [1, 2, 3] }))
    expect(pass.value).toBe(true)
    const fail = ev.evaluate(makeCtx({ output: [4, 5, 6] }))
    expect(fail.value).toBe(false)
  })

  test('Contains with objects', () => {
    const ev = new Contains({ value: { a: 1 } })
    expect(ev.evaluate(makeCtx({ output: { a: 1, b: 2 } })).value).toBe(true)
    expect(ev.evaluate(makeCtx({ output: { a: 2 } })).value).toBe(false)
    expect(ev.evaluate(makeCtx({ output: { b: 2 } })).value).toBe(false)
  })

  test('Contains with object key lookup', () => {
    const ev = new Contains({ value: 'key' })
    expect(ev.evaluate(makeCtx({ output: { key: 1 } })).value).toBe(true)
    expect(ev.evaluate(makeCtx({ output: { other: 2 } })).value).toBe(false)
  })

  test('Contains fallback failure', () => {
    const ev = new Contains({ value: 'x' })
    expect(ev.evaluate(makeCtx({ output: 42 })).value).toBe(false)
  })

  test('IsInstance checks type', () => {
    const ev = new IsInstance({ typeName: 'Object' })
    expect(ev.evaluate(makeCtx({ output: {} })).value).toBe(true)
    const stringEv = new IsInstance({ typeName: 'String' })
    expect(stringEv.evaluate(makeCtx({ output: 'hello' })).value).toBe(true)
    const failEv = new IsInstance({ typeName: 'Nope' })
    expect(failEv.evaluate(makeCtx({ output: 'x' })).value).toBe(false)
    expect(failEv.evaluate(makeCtx({ output: null })).value).toBe(false)
  })

  test('MaxDuration enforces limit', () => {
    const ev = new MaxDuration({ seconds: 1 })
    expect(ev.evaluate(makeCtx({ duration: 0.5 }))).toBe(true)
    expect(ev.evaluate(makeCtx({ duration: 1.5 }))).toBe(false)
  })

  test('HasMatchingSpan throws on SpanTreeRecordingError', () => {
    const ev = new HasMatchingSpan({ query: { name_equals: 'x' } })
    expect(() => ev.evaluate(makeCtx({}))).toThrow()
  })

  test('ConfusionMatrixEvaluator with labels', () => {
    const ev = new ConfusionMatrixEvaluator()
    const result = ev.evaluate({
      experimentMetadata: null,
      name: 'exp',
      report: {
        cases: [
          {
            assertions: {},
            expectedOutput: 'A',
            inputs: {},
            labels: {},
            metadata: null,
            metrics: {},
            name: 'c1',
            output: 'A',
            scores: {},
          },
          {
            assertions: {},
            expectedOutput: 'B',
            inputs: {},
            labels: {},
            metadata: null,
            metrics: {},
            name: 'c2',
            output: 'A',
            scores: {},
          },
        ],
      },
    } as unknown as ReportEvaluatorContext)
    expect(result.classLabels).toEqual(['A', 'B'])
    expect(result.matrix).toHaveLength(2)
  })
})
