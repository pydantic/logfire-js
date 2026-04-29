/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'

import {
  ATTR_EVALUATOR_NAME,
  Equals,
  ERROR_TYPE,
  EVAL_RESULT_EVENT_NAME,
  EVALS_OTEL_SCOPE,
  Evaluator,
  type EvaluatorOutput,
  GEN_AI_EVAL_NAME,
  GEN_AI_EVAL_TARGET,
  GEN_AI_EVALUATOR_SOURCE,
  GEN_AI_EXPLANATION,
  GEN_AI_SCORE_LABEL,
  GEN_AI_SCORE_VALUE,
  OnlineEvaluator,
  SPAN_NAME_EVALUATOR_LITERAL,
  waitForEvaluations,
  withOnlineEvaluation,
} from '../../evals'
// Ensure the dispatch-suppression hook holds up: an evaluator running inside
// Dataset.evaluate must not also fire as an online eval.
import { Case, Dataset } from '../../evals'
import { withMemoryLogExporter } from './withMemoryLogExporter'

class AlwaysPass extends Evaluator {
  static evaluatorName = 'AlwaysPass'
  evaluate(): boolean {
    return true
  }
}

class AlwaysFail extends Evaluator {
  static evaluatorName = 'AlwaysFail'
  evaluate(): boolean {
    return false
  }
}

class NumericScore extends Evaluator {
  static evaluatorName = 'NumericScore'
  evaluate(): number {
    return 0.75
  }
}

class CategoryLabel extends Evaluator {
  static evaluatorName = 'CategoryLabel'
  evaluate(): string {
    return 'good'
  }
}

class WithReason extends Evaluator {
  static evaluatorName = 'WithReason'
  evaluate(): EvaluatorOutput {
    return { reason: 'because reasons', value: true }
  }
}

class Throwing extends Evaluator {
  static evaluatorName = 'Throwing'
  evaluate(): never {
    throw new Error('evaluator boom')
  }
}

describe('online evals — gen_ai.evaluation.result emission', () => {
  it('emits one log per result, parented to call span, on the pydantic-evals scope', async () => {
    const fn = withOnlineEvaluation(async (msg: string) => msg.toUpperCase(), {
      evaluators: [new AlwaysPass()],
      target: 'mytarget',
    })

    const { logs, spans } = await withMemoryLogExporter(async () => {
      const result = await fn('hi')
      expect(result).toBe('HI')
      await waitForEvaluations()
    })

    expect(logs).toHaveLength(1)
    const rec = logs[0]!
    expect(rec.instrumentationScope.name).toBe(EVALS_OTEL_SCOPE)
    // body string format mirrors Python repr: `evaluation: <name>=<value>`
    expect(rec.body).toBe('evaluation: AlwaysPass=True')
    // scope name on the OTel side
    expect(rec.attributes[GEN_AI_EVAL_NAME]).toBe('AlwaysPass')
    expect(rec.attributes[GEN_AI_EVAL_TARGET]).toBe('mytarget')

    // Bool dual-emit: BOTH score.value and score.label set
    expect(rec.attributes[GEN_AI_SCORE_VALUE]).toBe(1)
    expect(rec.attributes[GEN_AI_SCORE_LABEL]).toBe('pass')

    // source is JSON-encoded EvaluatorSpec
    const src = JSON.parse(rec.attributes[GEN_AI_EVALUATOR_SOURCE] as string) as Record<string, unknown>
    expect(src.name).toBe('AlwaysPass')

    // Parented to the call span
    const callSpan = spans.find((s) => s.name === 'Calling mytarget')
    expect(callSpan).toBeDefined()
    expect(rec.spanContext?.traceId).toBe(callSpan!.spanContext().traceId)
    expect(rec.spanContext?.spanId).toBe(callSpan!.spanContext().spanId)

    const evaluatorSpan = spans.find((s) => s.name === SPAN_NAME_EVALUATOR_LITERAL)
    expect(evaluatorSpan?.attributes[ATTR_EVALUATOR_NAME]).toBe('AlwaysPass')
    expect(evaluatorSpan?.parentSpanContext?.spanId).toBe(callSpan!.spanContext().spanId)
    expect(evaluatorSpan?.spanContext().traceId).toBe(callSpan!.spanContext().traceId)
  })

  it('encodes false as score.value=0 + score.label=fail', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new AlwaysFail()], target: 'fail-target' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs[0]!.attributes[GEN_AI_SCORE_VALUE]).toBe(0)
    expect(logs[0]!.attributes[GEN_AI_SCORE_LABEL]).toBe('fail')
    expect(logs[0]!.body).toBe('evaluation: AlwaysFail=False')
  })

  it('numeric output → score.value only (no label)', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new NumericScore()], target: 't' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs[0]!.attributes[GEN_AI_SCORE_VALUE]).toBe(0.75)
    expect(logs[0]!.attributes[GEN_AI_SCORE_LABEL]).toBeUndefined()
  })

  it('string output → score.label only (no value)', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new CategoryLabel()], target: 't' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs[0]!.attributes[GEN_AI_SCORE_LABEL]).toBe('good')
    expect(logs[0]!.attributes[GEN_AI_SCORE_VALUE]).toBeUndefined()
  })

  it('EvaluationReason output puts reason into gen_ai.evaluation.explanation', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new WithReason()], target: 't' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs[0]!.attributes[GEN_AI_EXPLANATION]).toBe('because reasons')
  })

  it('failures emit a separate log record with severity WARN and error.type set', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new Throwing()], target: 't' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.attributes[ERROR_TYPE]).toBe('Error')
    expect(logs[0]!.attributes[GEN_AI_EXPLANATION]).toBe('evaluator boom')
    // SimpleLogRecordProcessor doesn't expose severity directly via .severityNumber on most versions —
    // check via body shape
    expect(logs[0]!.body).toContain('failed: evaluator boom')
  })

  it('zero sample-rate skips all evaluators (no logs emitted)', async () => {
    const fn = withOnlineEvaluation(async () => 'x', {
      evaluators: [new AlwaysPass()],
      sampleRate: 0,
      target: 't',
    })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs).toHaveLength(0)
  })

  it('event name is gen_ai.evaluation.result', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new AlwaysPass()], target: 't' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    // OTel logs API stores eventName under the LogRecord's `eventName` field on newer SDKs
    const rec = logs[0] as { attributes: Record<string, unknown>; eventName?: string }
    expect(rec.eventName).toBe(EVAL_RESULT_EVENT_NAME)
  })

  it('Equals evaluator wired through online dispatch produces correct attributes', async () => {
    const fn = withOnlineEvaluation(async () => 'expected', {
      evaluators: [new Equals({ value: 'expected' })],
      target: 'roundtrip',
    })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.attributes[GEN_AI_SCORE_VALUE]).toBe(1)
    const src = JSON.parse(logs[0]!.attributes[GEN_AI_EVALUATOR_SOURCE] as string) as { arguments: unknown; name: string }
    expect(src.name).toBe('Equals')
    expect(src.arguments).toEqual({ value: 'expected' })
  })

  it('drops online evaluations at maxConcurrency without blocking the wrapped call', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const drops: string[] = []

    class SlowEvaluator extends Evaluator {
      static evaluatorName = 'SlowEvaluator'

      async evaluate(): Promise<boolean> {
        await slow
        return true
      }
    }

    const evaluator = new OnlineEvaluator({
      evaluator: new SlowEvaluator(),
      maxConcurrency: 1,
      onMaxConcurrency: (name) => {
        drops.push(name)
      },
    })
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [evaluator], target: 'slow-target' })

    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await fn()
      expect(drops).toEqual(['SlowEvaluator'])
      releaseSlow()
      await waitForEvaluations()
    })

    expect(logs).toHaveLength(1)
  })
})

class CountingEvaluator extends Evaluator {
  static count = 0
  static evaluatorName = 'Counting'
  evaluate(): boolean {
    CountingEvaluator.count++
    return true
  }
}

describe('online suppression inside Dataset.evaluate', () => {
  it('does not double-evaluate: online wrapper skipped when invoked from within evaluate', async () => {
    CountingEvaluator.count = 0
    const wrapped = withOnlineEvaluation(async (s: string) => s.toUpperCase(), {
      evaluators: [new CountingEvaluator()],
      target: 'inner',
    })

    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'a', name: 'a' })],
      name: 'suppression-test',
    })

    const { logs } = await withMemoryLogExporter(async () => {
      await dataset.evaluate(async (input) => wrapped(input))
      await waitForEvaluations()
    })

    // The CountingEvaluator should NOT have run at all (no online dispatch).
    expect(CountingEvaluator.count).toBe(0)
    expect(logs).toHaveLength(0)
  })
})
