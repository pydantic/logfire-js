/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest'

import { ATTRIBUTES_MESSAGE_KEY, ATTRIBUTES_MESSAGE_TEMPLATE_KEY } from '../../constants'
import {
  ATTR_ASSERTIONS,
  ATTR_CASE_NAME,
  ATTR_DATASET_NAME,
  ATTR_INPUTS,
  ATTR_N_CASES,
  ATTR_NAME,
  ATTR_OUTPUT,
  ATTR_SCORES,
  ATTR_TASK_NAME,
  Case,
  Contains,
  Dataset,
  Equals,
  EqualsExpected,
  EVALS_OTEL_SCOPE,
  Evaluator,
  EXPERIMENT_METADATA_KEY,
  EXPERIMENT_REPEAT_KEY,
  EXPERIMENT_SOURCE_CASE_NAME_KEY,
  GEN_AI_OPERATION_NAME,
  getCurrentTaskRun,
  incrementEvalMetric,
  OPERATION_EXPERIMENT,
  setEvalAttribute,
  SPAN_NAME_CASE,
  SPAN_NAME_EVALUATOR_LITERAL,
  SPAN_NAME_EXECUTE,
  SPAN_NAME_EXPERIMENT,
} from '../../evals'
import { withMemoryExporter } from './withMemoryExporter'

interface ClassifyInputs {
  text: string
}

const classify = async ({ text }: ClassifyInputs): Promise<string> => {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('fail')) return 'NEGATIVE'
  if (lower.includes('great') || lower.includes('love')) return 'POSITIVE'
  return 'NEUTRAL'
}

describe('offline evals — span attribute parity', () => {
  it('emits experiment / case / execute / evaluator spans on the pydantic-evals scope', async () => {
    const dataset = new Dataset<ClassifyInputs, string>({
      cases: [
        new Case({ expectedOutput: 'POSITIVE', inputs: { text: 'I love this!' }, name: 'positive-1' }),
        new Case({ expectedOutput: 'NEGATIVE', inputs: { text: 'This is an error' }, name: 'negative-1' }),
      ],
      evaluators: [new EqualsExpected()],
      name: 'sentiment-classifier',
    })

    const { result, spans } = await withMemoryExporter(async () => {
      return dataset.evaluate(classify)
    })

    // Every evals span lives on the pydantic-evals OTel scope (per platform ingest contract).
    for (const s of spans) {
      expect(s.instrumentationScope.name).toBe(EVALS_OTEL_SCOPE)
    }

    const experiment = spans.find((s) => s.name === SPAN_NAME_EXPERIMENT)
    const cases = spans.filter((s) => s.name === SPAN_NAME_CASE)
    const executes = spans.filter((s) => s.name === SPAN_NAME_EXECUTE)
    const evaluators = spans.filter((s) => s.name === SPAN_NAME_EVALUATOR_LITERAL)

    expect(experiment).toBeDefined()
    expect(cases).toHaveLength(2)
    expect(executes).toHaveLength(2)
    expect(evaluators).toHaveLength(2) // 1 evaluator × 2 cases

    // Experiment span attributes — Condition-2 ingest discriminator + sort-by-pass-rate fields.
    const expAttrs = experiment!.attributes
    expect(expAttrs[ATTR_NAME]).toBe('classify')
    expect(expAttrs[ATTR_DATASET_NAME]).toBe('sentiment-classifier')
    expect(expAttrs[ATTR_TASK_NAME]).toBe('classify')
    expect(expAttrs[ATTR_N_CASES]).toBe(2)
    expect(expAttrs[GEN_AI_OPERATION_NAME]).toBe(OPERATION_EXPERIMENT)
    expect(expAttrs[EXPERIMENT_REPEAT_KEY]).toBeUndefined() // repeat=1 → not set
    expect(expAttrs[ATTRIBUTES_MESSAGE_TEMPLATE_KEY]).toBe(SPAN_NAME_EXPERIMENT)
    // logfire.experiment.metadata MUST be a JSON-encoded object (per fusionfire ingest)
    const metadata = JSON.parse(expAttrs[EXPERIMENT_METADATA_KEY] as string) as Record<string, unknown>
    expect(metadata.n_cases).toBe(2)
    expect(metadata.averages).toBeDefined()
    expect((metadata.averages as { name: string }).name).toBe('classify')

    // Each case span has case_name as a top-level attribute (UI detection requirement)
    for (const c of cases) {
      expect(c.attributes[ATTR_CASE_NAME]).toBeDefined()
      expect(c.attributes[ATTR_INPUTS]).toBeDefined()
      expect(c.attributes[ATTR_OUTPUT]).toBeDefined()
      expect(c.attributes[ATTR_TASK_NAME]).toBe('classify')
      expect(c.attributes[ATTRIBUTES_MESSAGE_TEMPLATE_KEY]).toBe(SPAN_NAME_CASE)
    }

    // Evaluator span uses friendly msg_template + stable span name (the "dual" pattern).
    for (const e of evaluators) {
      expect(e.name).toBe(SPAN_NAME_EVALUATOR_LITERAL)
      expect(e.attributes[ATTRIBUTES_MESSAGE_TEMPLATE_KEY]).toBe('Calling evaluator: {evaluator_name}')
      expect(e.attributes[ATTRIBUTES_MESSAGE_KEY]).toContain('Calling evaluator: ')
      expect(e.attributes.evaluator_name).toBe('EqualsExpected')
    }

    // Cases are children of the experiment span (within the same trace).
    for (const c of cases) {
      expect(c.parentSpanContext?.spanId).toBe(experiment!.spanContext().spanId)
      expect(c.spanContext().traceId).toBe(experiment!.spanContext().traceId)
    }

    // Report has populated trace_id/span_id (regression vs. PR #104).
    expect(result.trace_id).toBe(experiment!.spanContext().traceId)
    expect(result.span_id).toBe(experiment!.spanContext().spanId)
    expect(result.cases).toHaveLength(2)
    for (const rc of result.cases) {
      expect(rc.trace_id).toBeTypeOf('string')
      expect(rc.span_id).toBeTypeOf('string')
    }
  })

  it('encodes assertions/scores/labels as JSON-object attributes with the canonical EvaluationResult shape', async () => {
    const dataset = new Dataset<{ x: number }, number>({
      cases: [new Case<{ x: number }, number>({ expectedOutput: 1, inputs: { x: 1 }, name: 'a' })],
      evaluators: [new EqualsExpected(), new Equals({ value: 1 })],
      name: 'shape-test',
    })

    const { spans } = await withMemoryExporter(() => dataset.evaluate(({ x }) => x))

    const caseSpan = spans.find((s) => s.name === SPAN_NAME_CASE)
    expect(caseSpan).toBeDefined()
    const assertions = JSON.parse(caseSpan!.attributes[ATTR_ASSERTIONS] as string) as Record<string, unknown>
    expect(Object.keys(assertions).sort()).toEqual(['Equals', 'EqualsExpected'])
    const eq = assertions.Equals as Record<string, unknown>
    expect(eq.name).toBe('Equals')
    expect(eq.value).toBe(true)
    expect((eq.source as { name: string }).name).toBe('Equals')
    expect((eq.source as { arguments: unknown }).arguments).toEqual({ value: 1 })

    const scoresAttr = caseSpan!.attributes[ATTR_SCORES] as string
    const scores = JSON.parse(scoresAttr) as Record<string, unknown>
    expect(scores).toEqual({})
  })

  it('runs case evaluators before dataset evaluators and suffixes duplicate result names', async () => {
    class SameNameEvaluator extends Evaluator {
      static evaluatorName = 'SameNameEvaluator'
      private readonly value: boolean
      constructor(evaluationName: string, value: boolean) {
        super()
        this.evaluationName = evaluationName
        this.value = value
      }
      evaluate(): boolean {
        return this.value
      }
    }

    const dataset = new Dataset<string, string>({
      cases: [
        new Case<string, string>({
          evaluators: [new SameNameEvaluator('duplicate', true)],
          inputs: 'x',
          name: 'case',
        }),
      ],
      evaluators: [new SameNameEvaluator('duplicate', false)],
      name: 'ordering-test',
    })

    const { result } = await withMemoryExporter(() => dataset.evaluate((input) => input))

    expect(Object.keys(result.cases[0]!.assertions)).toEqual(['duplicate', 'duplicate_2'])
    expect(result.cases[0]?.assertions.duplicate?.value).toBe(true)
    expect(result.cases[0]?.assertions.duplicate_2?.value).toBe(false)
  })

  it('runs evaluators for a case concurrently', async () => {
    let fastStarted = false
    class SlowEvaluator extends Evaluator {
      static evaluatorName = 'SlowEvaluator'
      async evaluate(): Promise<boolean> {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return fastStarted
      }
    }
    class FastEvaluator extends Evaluator {
      static evaluatorName = 'FastEvaluator'
      evaluate(): boolean {
        fastStarted = true
        return true
      }
    }

    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'x', name: 'case' })],
      evaluators: [new SlowEvaluator(), new FastEvaluator()],
      name: 'parallel-evaluator-test',
    })

    const { result } = await withMemoryExporter(() => dataset.evaluate((input) => input))

    expect(result.cases[0]?.assertions.SlowEvaluator?.value).toBe(true)
    expect(result.cases[0]?.assertions.FastEvaluator?.value).toBe(true)
  })

  it('emits logfire.experiment.repeat and source_case_name on multi-run experiments', async () => {
    const dataset = new Dataset({
      cases: [new Case({ inputs: 'hi', name: 'x' })],
      name: 'multi-run-test',
    })
    const { spans } = await withMemoryExporter(() => dataset.evaluate(() => 'ok', { repeat: 3 }))

    const experiment = spans.find((s) => s.name === SPAN_NAME_EXPERIMENT)
    expect(experiment!.attributes[EXPERIMENT_REPEAT_KEY]).toBe(3)
    expect(experiment!.attributes[ATTR_N_CASES]).toBe(3)

    const cases = spans.filter((s) => s.name === SPAN_NAME_CASE)
    expect(cases).toHaveLength(3)
    for (const c of cases) {
      expect(c.attributes[EXPERIMENT_SOURCE_CASE_NAME_KEY]).toBe('x')
      expect(c.attributes[ATTR_CASE_NAME]).toMatch(/^x \[\d+\/3\]$/)
    }
  })

  it('records a case failure when the task throws, without aborting the experiment', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'good' }), new Case<string, string>({ inputs: 'b', name: 'bad' })],
      name: 'failure-test',
    })

    const { result } = await withMemoryExporter(() =>
      dataset.evaluate((inputs) => {
        if (inputs === 'b') throw new Error('boom')
        return inputs
      })
    )

    expect(result.cases).toHaveLength(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.name).toBe('bad')
    expect(result.failures[0]?.error_message).toBe('boom')
    expect(result.failures[0]?.error_type).toBe('Error')
  })

  it('Contains evaluator works on string outputs and produces a label-shaped result for non-string outputs', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'find me', name: 'findcase' })],
      evaluators: [new Contains({ value: 'find' })],
      name: 'contains-test',
    })
    const { result } = await withMemoryExporter(() => dataset.evaluate((s) => s))
    expect(result.cases[0]?.assertions.Contains?.value).toBe(true)
    expect(result.cases[0]?.assertions.Contains?.reason).toBeNull()
  })

  it('supports addCase/addEvaluator, task helpers, progress callbacks and custom evaluator versions', async () => {
    class VersionedEvaluator extends Evaluator {
      static evaluatorName = 'VersionedEvaluator'
      evaluatorVersion = '2026-01-01'

      evaluate(): Record<string, boolean | number | string> {
        return { label: 'ok', score: 0.5, versioned: true }
      }
    }

    const dataset = new Dataset<{ n: number }, number>({ name: 'mutation-test' })
    dataset.addCase({ inputs: { n: 1 }, name: 'one' })
    dataset.addCase({ inputs: { n: 2 }, name: 'two' })
    dataset.addEvaluator(new Equals({ value: 1 }), { specificCase: 'one' })
    dataset.addEvaluator(new VersionedEvaluator())

    expect(() => {
      dataset.addCase({ inputs: { n: 3 }, name: 'one' })
    }).toThrow('Duplicate case name: "one"')
    dataset.cases.pop()
    expect(() => {
      dataset.addEvaluator(new EqualsExpected(), { specificCase: 'missing' })
    }).toThrow('addEvaluator: no case named "missing"')

    const progress: { caseName: string; done: number; total: number }[] = []
    const { result } = await withMemoryExporter(() =>
      dataset.evaluate(
        ({ n }) => {
          expect(getCurrentTaskRun()).toBeDefined()
          setEvalAttribute('seen', n)
          incrementEvalMetric('calls', 1)
          incrementEvalMetric('calls', 2)
          return n
        },
        { progress: (event) => progress.push(event) }
      )
    )

    expect(progress.map((event) => event.caseName).sort()).toEqual(['one', 'two'])
    expect(progress.map((event) => event.done).sort()).toEqual([1, 2])
    expect(progress.map((event) => event.total)).toEqual([2, 2])
    const casesByName = [...result.cases].sort((a, b) => a.name.localeCompare(b.name))
    expect(casesByName.map((c) => c.attributes)).toEqual([{ seen: 1 }, { seen: 2 }])
    expect(casesByName.map((c) => c.metrics)).toEqual([{ calls: 3 }, { calls: 3 }])
    expect(casesByName[0]?.assertions.Equals?.value).toBe(true)
    expect(casesByName[0]?.assertions.versioned?.evaluator_version).toBe('2026-01-01')
    expect(casesByName[0]?.scores.score?.value).toBe(0.5)
    expect(casesByName[0]?.labels.label?.value).toBe('ok')

    setEvalAttribute('outside', true)
    incrementEvalMetric('outside', 1)
    expect(getCurrentTaskRun()).toBeUndefined()

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let messages: string[] = []
    try {
      await withMemoryExporter(() => dataset.evaluate(({ n }) => n, { progress: true }))
      messages = error.mock.calls.map((call) => String(call[0]))
    } finally {
      error.mockRestore()
    }
    expect(messages).toHaveLength(2)
    expect(messages.every((message) => /^\[\d\/2\] (?:one|two)$/.test(message))).toBe(true)
    expect(messages.map((message) => message.replace(/^\[\d\/2\] /, '')).sort()).toEqual(['one', 'two'])
  })

  it('records non-Error task failures without rejecting the experiment', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'x', name: 'x' })],
      name: 'non-error-failure',
    })

    const { result, spans } = await withMemoryExporter(() =>
      dataset.evaluate(() => {
        // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
        throw 'string boom'
      })
    )

    expect(result.failures).toMatchObject([{ error_message: 'string boom', error_type: 'Error', name: 'x' }])
    const caseSpan = spans.find((s) => s.name === SPAN_NAME_CASE)
    expect(caseSpan?.events.some((event) => event.attributes?.['exception.message'] === 'string boom')).toBe(true)
  })

  it('returns an empty report when aborted before cases start', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'x', name: 'x' })],
      name: 'aborted-before-start',
    })
    const controller = new AbortController()
    controller.abort()

    const { result } = await withMemoryExporter(() => dataset.evaluate((input) => input, { signal: controller.signal }))

    expect(result.cases).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('uses taskName and explicit name option for the report and span attributes', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'one' })],
      name: 'naming-test',
    })

    const { result: customTask, spans: customSpans } = await withMemoryExporter(() =>
      dataset.evaluate((s) => s, { taskName: 'custom_task' })
    )
    expect(customTask.name).toBe('custom_task')
    const exp1 = customSpans.find((s) => s.name === SPAN_NAME_EXPERIMENT)
    expect(exp1!.attributes[ATTR_TASK_NAME]).toBe('custom_task')
    expect(exp1!.attributes[ATTR_NAME]).toBe('custom_task')

    const { result: customExp, spans: customExpSpans } = await withMemoryExporter(() =>
      dataset.evaluate((s) => s, { name: 'custom_experiment', taskName: 'custom_task' })
    )
    expect(customExp.name).toBe('custom_experiment')
    const exp2 = customExpSpans.find((s) => s.name === SPAN_NAME_EXPERIMENT)
    expect(exp2!.attributes[ATTR_TASK_NAME]).toBe('custom_task')
    expect(exp2!.attributes[ATTR_NAME]).toBe('custom_experiment')
  })

  it('passes options.metadata through to report.experiment_metadata and the span', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'one' })],
      name: 'metadata-test',
    })
    const metadata = { max_tokens: 1000, model: 'gpt-4o', prompt_version: 'v2.1' }

    const { result, spans } = await withMemoryExporter(() => dataset.evaluate((s) => s, { metadata }))

    expect(result.experiment_metadata).toEqual(metadata)
    const exp = spans.find((s) => s.name === SPAN_NAME_EXPERIMENT)
    const meta = JSON.parse(exp!.attributes[EXPERIMENT_METADATA_KEY] as string) as { metadata?: unknown }
    expect(meta.metadata).toEqual(metadata)
  })

  it('returns an empty report for a dataset with no cases', async () => {
    const dataset = new Dataset<string, string>({ cases: [], name: 'empty' })
    const { result } = await withMemoryExporter(() => dataset.evaluate(() => 'unused'))
    expect(result.cases).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('assigns positional names to unnamed cases interleaved with named ones', async () => {
    const dataset = new Dataset<string, string>({
      cases: [
        new Case<string, string>({ inputs: 'a' }),
        new Case<string, string>({ inputs: 'b', name: 'My Case' }),
        new Case<string, string>({ inputs: 'c' }),
      ],
      name: 'unnamed',
    })

    const { result } = await withMemoryExporter(() => dataset.evaluate((s) => s.toUpperCase()))
    expect([...result.cases].sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.name)).toEqual(['Case 1', 'Case 3', 'My Case'])
  })

  it('incrementEvalMetric with amount 0 does not create the metric', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'x' })],
      name: 'increment-zero',
    })
    const { result } = await withMemoryExporter(() =>
      dataset.evaluate((input) => {
        incrementEvalMetric('phantom', 0)
        incrementEvalMetric('real', 1)
        return input
      })
    )
    expect(result.cases[0]?.metrics).toEqual({ real: 1 })
  })

  it('respects maxConcurrency by serializing case execution', async () => {
    let inFlight = 0
    let peakInFlight = 0
    const dataset = new Dataset<string, string>({
      cases: [
        new Case<string, string>({ inputs: 'a', name: 'a' }),
        new Case<string, string>({ inputs: 'b', name: 'b' }),
        new Case<string, string>({ inputs: 'c', name: 'c' }),
        new Case<string, string>({ inputs: 'd', name: 'd' }),
      ],
      name: 'concurrency-test',
    })

    await withMemoryExporter(() =>
      dataset.evaluate(
        async (input) => {
          inFlight += 1
          peakInFlight = Math.max(peakInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return input
        },
        { maxConcurrency: 1 }
      )
    )
    expect(peakInFlight).toBe(1)
  })

  it('records evaluator failures as evaluator_failures without aborting the experiment', async () => {
    class FailingEvaluator extends Evaluator {
      static evaluatorName = 'FailingEvaluator'
      evaluate(): never {
        throw new Error('Evaluator error')
      }
    }
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'one' }), new Case<string, string>({ inputs: 'b', name: 'two' })],
      evaluators: [new FailingEvaluator()],
      name: 'failing-eval',
    })

    const { result } = await withMemoryExporter(() => dataset.evaluate((s) => s.toUpperCase()))

    expect(result.cases).toHaveLength(2)
    expect(result.failures).toEqual([])
    for (const c of result.cases) {
      expect(c.assertions).toEqual({})
      expect(c.evaluator_failures).toMatchObject([{ error_message: 'Evaluator error', error_type: 'Error', name: 'FailingEvaluator' }])
    }
  })
})
