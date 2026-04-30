/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { context as ContextAPI, propagation, trace as TraceAPI } from '@opentelemetry/api'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  ATTR_EVALUATOR_NAME,
  Case,
  configureOnlineEvals,
  Dataset,
  disableEvaluation,
  emitEvaluatorFailure,
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
  getOnlineEvalConfig,
  HasMatchingSpan,
  OnlineEvaluator,
  type SinkPayload,
  SPAN_NAME_EVALUATOR_LITERAL,
  waitForEvaluations,
  withOnlineEvaluation,
} from '../../evals'
// Ensure the dispatch-suppression hook holds up: an evaluator running inside
// Dataset.evaluate must not also fire as an online eval.
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

class TinyScore extends Evaluator {
  static evaluatorName = 'TinyScore'
  evaluate(): number {
    return 1.23e-7
  }
}

class LargeIntegerScore extends Evaluator {
  static evaluatorName = 'LargeIntegerScore'
  evaluate(): number {
    return 1234567
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
  it('exposes global config and OnlineEvaluator wrapper properties', () => {
    const sinkPayloads: SinkPayload[] = []
    configureOnlineEvals({
      metadata: { suite: 'online' },
      sink: (payload) => {
        sinkPayloads.push(payload)
      },
    })
    try {
      expect(getOnlineEvalConfig().metadata).toEqual({ suite: 'online' })
      const evaluator = new OnlineEvaluator({
        evaluator: new AlwaysPass(),
        sampleRate: 0.25,
        sink: (payload) => {
          sinkPayloads.push(payload)
        },
      })
      expect(evaluator.name).toBe('AlwaysPass')
      expect(evaluator.evaluator).toBeInstanceOf(AlwaysPass)
      expect(evaluator.sampleRate).toBe(0.25)
      expect(evaluator.sink).toBeTypeOf('function')
    } finally {
      configureOnlineEvals({ metadata: undefined, sink: undefined })
    }
  })

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
    expect(logs[0]!.body).toBe('evaluation: NumericScore=0.75')
    expect((logs[0] as { severityNumber?: unknown }).severityNumber).toBeUndefined()
  })

  it('formats numeric result bodies like Python general format', async () => {
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new TinyScore(), new LargeIntegerScore()], target: 't' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs.map((log) => log.body)).toEqual(['evaluation: TinyScore=1.23e-07', 'evaluation: LargeIntegerScore=1.23457e+06'])
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

  it('emits Python-compatible evaluator failure fallbacks when message/type are missing', async () => {
    const { logs } = await withMemoryLogExporter(() => {
      emitEvaluatorFailure(
        {
          error_message: '',
          error_type: '',
          name: 'MissingFailureFields',
          source: { arguments: null, name: 'MissingFailureFields' },
        },
        { target: 'fallback-target' }
      )
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]?.body).toBe('evaluation: MissingFailureFields failed')
    expect(logs[0]?.attributes[ERROR_TYPE]).toBe('pydantic_evals.EvaluatorFailure')
  })

  it('converts online evaluator failures without calling onError', async () => {
    const errors: unknown[] = []
    const globalErrors: unknown[] = []
    const sinkPayloads: SinkPayload[] = []
    const fn = withOnlineEvaluation(async () => 'x', {
      evaluators: [
        new OnlineEvaluator({
          evaluator: new Throwing(),
          onError: (error) => {
            errors.push(error)
          },
        }),
      ],
      sink: (payload) => {
        sinkPayloads.push(payload)
      },
      target: 'error-hook-target',
    })
    const globalFn = withOnlineEvaluation(async () => 'x', {
      evaluators: [new Throwing()],
      target: 'global-error-hook-target',
    })

    configureOnlineEvals({
      onError: (error) => {
        globalErrors.push(error)
      },
    })
    try {
      await withMemoryLogExporter(async () => {
        await fn()
        await globalFn()
        await waitForEvaluations()
      })
    } finally {
      configureOnlineEvals({ onError: undefined })
    }

    expect(errors).toHaveLength(0)
    expect(globalErrors).toHaveLength(0)
    expect(sinkPayloads).toHaveLength(1)
    expect(sinkPayloads[0]?.failures[0]?.name).toBe('Throwing')
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

  it('sampling errors call onSamplingError and skip evaluation without failing the wrapped call', async () => {
    const samplingErrors: unknown[] = []
    const fn = withOnlineEvaluation(async () => 'x', {
      evaluators: [new AlwaysPass()],
      onSamplingError: (err) => {
        samplingErrors.push(err)
      },
      sampleRate: () => {
        throw new Error('sampling boom')
      },
      target: 'sampling-error-target',
    })

    const { logs } = await withMemoryLogExporter(async () => {
      await expect(fn()).resolves.toBe('x')
      await waitForEvaluations()
    })

    expect(logs).toHaveLength(0)
    expect(samplingErrors).toHaveLength(1)
    expect(samplingErrors[0]).toBeInstanceOf(Error)
    expect((samplingErrors[0] as Error).message).toBe('sampling boom')
  })

  it('global enabled=false bypasses evaluators and leaves the wrapped call intact', async () => {
    let evaluateCount = 0
    class Counting extends Evaluator {
      static evaluatorName = 'Counting'
      evaluate(): boolean {
        evaluateCount++
        return true
      }
    }

    configureOnlineEvals({ enabled: false })
    try {
      const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new Counting()], target: 'disabled-target' })
      const { logs } = await withMemoryLogExporter(async () => {
        await expect(fn()).resolves.toBe('x')
        await waitForEvaluations()
      })

      expect(evaluateCount).toBe(0)
      expect(logs).toHaveLength(0)
    } finally {
      configureOnlineEvals({ enabled: true })
    }
  })

  it('disableEvaluation suppresses dispatch until disposed', async () => {
    const handle = disableEvaluation()
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new AlwaysPass()], target: 'disabled-handle-target' })
    try {
      const { logs } = await withMemoryLogExporter(async () => {
        await expect(fn()).resolves.toBe('x')
        await waitForEvaluations()
      })
      expect(logs).toHaveLength(0)
    } finally {
      handle.dispose()
      handle.dispose()
    }

    const { logs } = await withMemoryLogExporter(async () => {
      await expect(fn()).resolves.toBe('x')
      await waitForEvaluations()
    })
    expect(logs).toHaveLength(1)
  })

  it('emitOtelEvents=false still runs evaluators and sends sink payloads without log records', async () => {
    const sinkPayloads: SinkPayload[] = []
    const evaluatorSinkPayloads: SinkPayload[] = []
    const fn = withOnlineEvaluation(async () => 'x', {
      emitOtelEvents: false,
      evaluators: [
        new OnlineEvaluator({
          evaluator: new AlwaysPass(),
          sink: (payload) => {
            evaluatorSinkPayloads.push(payload)
          },
        }),
      ],
      sink: (payload) => {
        sinkPayloads.push(payload)
      },
      target: 'sink-only-target',
    })

    configureOnlineEvals({ metadata: { suite: 'online' } })
    try {
      const { logs } = await withMemoryLogExporter(async () => {
        await expect(fn()).resolves.toBe('x')
        await waitForEvaluations()
      })

      expect(logs).toHaveLength(0)
    } finally {
      configureOnlineEvals({ metadata: undefined })
    }
    expect(sinkPayloads).toHaveLength(1)
    expect(sinkPayloads[0]?.context.metadata).toEqual({ suite: 'online' })
    expect(sinkPayloads[0]?.context.attributes).toEqual({})
    expect(sinkPayloads[0]?.results).toHaveLength(1)
    expect(sinkPayloads[0]?.results[0]?.name).toBe('AlwaysPass')
    expect(evaluatorSinkPayloads).toHaveLength(1)
    expect(evaluatorSinkPayloads[0]?.results[0]?.name).toBe('AlwaysPass')
  })

  it('skips evaluator execution when OTel events and sinks are both disabled', async () => {
    let attempts = 0
    class Counting extends Evaluator {
      static evaluatorName = 'NoSinkCounting'
      evaluate(): boolean {
        attempts++
        return true
      }
    }

    const fn = withOnlineEvaluation(async () => 'x', {
      emitOtelEvents: false,
      evaluators: [new Counting()],
      target: 'short-circuit-target',
    })

    const { logs } = await withMemoryLogExporter(async () => {
      await expect(fn()).resolves.toBe('x')
      await waitForEvaluations()
    })

    expect(attempts).toBe(0)
    expect(logs).toHaveLength(0)
  })

  it('batches OnlineEvaluator sinks by sink identity', async () => {
    const sinkPayloads: SinkPayload[] = []
    const sharedSink = (payload: SinkPayload): void => {
      sinkPayloads.push(payload)
    }
    const fn = withOnlineEvaluation(async () => 'x', {
      emitOtelEvents: false,
      evaluators: [
        new OnlineEvaluator({ evaluator: new AlwaysPass(), sink: sharedSink }),
        new OnlineEvaluator({ evaluator: new AlwaysFail(), sink: sharedSink }),
      ],
      target: 'batched-sink-target',
    })

    await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })

    expect(sinkPayloads).toHaveLength(1)
    expect(sinkPayloads[0]?.results.map((result) => result.name).sort()).toEqual(['AlwaysFail', 'AlwaysPass'])
  })

  it('runs sampled online evaluators concurrently', async () => {
    let fastStarted = false
    class SlowOnlineEvaluator extends Evaluator {
      static evaluatorName = 'SlowOnlineEvaluator'
      async evaluate(): Promise<boolean> {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return fastStarted
      }
    }
    class FastOnlineEvaluator extends Evaluator {
      static evaluatorName = 'FastOnlineEvaluator'
      evaluate(): boolean {
        fastStarted = true
        return true
      }
    }

    const fn = withOnlineEvaluation(async () => 'x', {
      evaluators: [new SlowOnlineEvaluator(), new FastOnlineEvaluator()],
      target: 'parallel-online-target',
    })

    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })

    expect(logs.find((log) => log.attributes[GEN_AI_EVAL_NAME] === 'SlowOnlineEvaluator')?.attributes[GEN_AI_SCORE_VALUE]).toBe(1)
  })

  it('calls onError with Python-style arguments for sink failures', async () => {
    const errors: { error: unknown; evaluator: Evaluator; location: string; output: unknown }[] = []
    const fn = withOnlineEvaluation(async () => 'x', {
      emitOtelEvents: false,
      evaluators: [new AlwaysPass()],
      onError: (error, context, evaluator, location) => {
        errors.push({ error, evaluator, location, output: context.output })
      },
      sink: () => {
        throw new Error('sink boom')
      },
      target: 'sink-error-target',
    })

    await withMemoryLogExporter(async () => {
      await expect(fn()).resolves.toBe('x')
      await waitForEvaluations()
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toBeInstanceOf(Error)
    expect(errors[0]?.evaluator).toBeInstanceOf(AlwaysPass)
    expect(errors[0]?.location).toBe('sink')
    expect(errors[0]?.output).toBe('x')
  })

  it('extracts call arguments, records return values and propagates baggage to emitted logs', async () => {
    async function answer(first: string, count = 1): Promise<{ count: number; first: string }> {
      return { count, first }
    }

    const fn = withOnlineEvaluation(answer, {
      evaluators: [new AlwaysPass()],
      extractArgs: true,
      recordReturn: true,
      target: 'argument-target',
    })
    const baggage = propagation.createBaggage({ tenant: { value: 'acme' } })

    const { logs, spans } = await withMemoryLogExporter(async () =>
      ContextAPI.with(propagation.setBaggage(ContextAPI.active(), baggage), async () => {
        await expect(fn('hello', 3)).resolves.toEqual({ count: 3, first: 'hello' })
        await waitForEvaluations()
      })
    )

    const callSpan = spans.find((s) => s.name === 'Calling argument-target')!
    expect(callSpan.attributes).toMatchObject({
      count: 3,
      first: 'hello',
      return: '{"count":3,"first":"hello"}',
      target: 'argument-target',
    })
    expect(logs[0]?.attributes.tenant).toBe('acme')
  })

  it('uses independent per-evaluator sampling by default and names context inputs when possible', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.4).mockReturnValueOnce(0.6).mockReturnValue(0.1)
    const sinkPayloads: SinkPayload[] = []
    const fn = withOnlineEvaluation(async (first: string, second: string) => `${first}${second}`, {
      evaluators: [
        new OnlineEvaluator({ evaluator: new AlwaysPass(), sampleRate: 0.5 }),
        new OnlineEvaluator({ evaluator: new AlwaysFail(), sampleRate: 0.5 }),
      ],
      extractArgs: ['renamedFirst', 'renamedSecond'],
      sink: (payload) => {
        sinkPayloads.push(payload)
      },
      target: 'independent-target',
    })

    try {
      const { logs, spans } = await withMemoryLogExporter(async () => {
        await fn('a', 'b')
        await waitForEvaluations()
      })
      expect(logs).toHaveLength(1)
      expect(logs[0]?.attributes[GEN_AI_EVAL_NAME]).toBe('AlwaysPass')
      const callSpan = spans.find((s) => s.name === 'Calling independent-target')!
      expect(callSpan.attributes).toMatchObject({ renamedFirst: 'a', renamedSecond: 'b' })
      expect(sinkPayloads[0]?.context.inputs).toEqual({ renamedFirst: 'a', renamedSecond: 'b' })
    } finally {
      random.mockRestore()
    }
  })

  it('does not inspect argument names for evaluator inputs when extractArgs is false', async () => {
    const sinkPayloads: SinkPayload[] = []
    const fn = withOnlineEvaluation(async (first: string, second: string) => `${first}${second}`, {
      evaluators: [new AlwaysPass()],
      extractArgs: false,
      sink: (payload) => {
        sinkPayloads.push(payload)
      },
      target: 'positional-target',
    })

    await withMemoryLogExporter(async () => {
      await fn('a', 'b')
      await waitForEvaluations()
    })

    expect(sinkPayloads[0]?.context.inputs).toEqual(['a', 'b'])
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

  it('emits one log per named output when an evaluator returns a result object', async () => {
    class MultiOutput extends Evaluator {
      static evaluatorName = 'MultiOutput'

      evaluate(): Record<string, boolean | number | string> {
        return { assertion: true, label: 'great', score: 0.95 }
      }
    }

    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new MultiOutput()], target: 'multi-output-target' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })

    expect(logs.map((log) => log.attributes[GEN_AI_EVAL_NAME]).sort()).toEqual(['assertion', 'label', 'score'])
    expect(logs.find((log) => log.attributes[GEN_AI_EVAL_NAME] === 'assertion')?.attributes[GEN_AI_SCORE_VALUE]).toBe(1)
    expect(logs.find((log) => log.attributes[GEN_AI_EVAL_NAME] === 'label')?.attributes[GEN_AI_SCORE_LABEL]).toBe('great')
    expect(logs.find((log) => log.attributes[GEN_AI_EVAL_NAME] === 'score')?.attributes[GEN_AI_SCORE_VALUE]).toBe(0.95)
  })

  it('cleans up captured spans and does not dispatch evaluators when the wrapped call fails', async () => {
    const fn = withOnlineEvaluation(
      async () => {
        throw new Error('call failed')
      },
      { evaluators: [new AlwaysPass()], target: 'failing-call-target' }
    )

    const { logs } = await withMemoryLogExporter(async () => {
      await expect(fn()).rejects.toThrow('call failed')
      await waitForEvaluations()
    })

    expect(logs).toHaveLength(0)
  })

  it('OnlineEvaluator.tryRun can execute without a parent call span reference', async () => {
    const evaluator = new OnlineEvaluator({ evaluator: new AlwaysPass() })
    const { result, spans } = await withMemoryLogExporter(() =>
      evaluator.tryRun(
        {
          attributes: {},
          duration: 0,
          inputs: 'x',
          metrics: {},
          output: 'x',
          spanTree: { any: () => false } as never,
        },
        null
      )
    )

    expect(result.results[0]?.name).toBe('AlwaysPass')
    const evaluatorSpan = spans.find((s) => s.name === SPAN_NAME_EVALUATOR_LITERAL)
    expect(evaluatorSpan?.parentSpanContext).toBeUndefined()
  })

  it('captures wrapped-call spans into online evaluator context', async () => {
    const fn = withOnlineEvaluation(
      async (input: string) => {
        const tracer = TraceAPI.getTracer('online-user-code')
        await tracer.startActiveSpan('inner-op', async (span) => {
          span.setAttribute('user.input', input)
          span.end()
        })
        return input.toUpperCase()
      },
      {
        evaluators: [new HasMatchingSpan({ query: { nameEquals: 'inner-op' } })],
        target: 'online-span-target',
      }
    )

    const { logs } = await withMemoryLogExporter(async () => {
      const result = await fn('hi')
      expect(result).toBe('HI')
      await waitForEvaluations()
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]!.body).toBe('evaluation: HasMatchingSpan=True')
    expect(logs[0]!.attributes[GEN_AI_SCORE_VALUE]).toBe(1)
    expect(logs[0]!.attributes[GEN_AI_SCORE_LABEL]).toBe('pass')
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
    })
    const fn = withOnlineEvaluation(async () => 'x', {
      evaluators: [evaluator],
      onMaxConcurrency: (context) => {
        drops.push(String(context.output))
      },
      target: 'slow-target',
    })

    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await fn()
      expect(drops).toEqual(['x'])
      releaseSlow()
      await waitForEvaluations()
    })

    expect(logs).toHaveLength(1)
  })

  it('routes onMaxConcurrency callback errors through onError', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const errors: { evaluator: Evaluator; location: string; output: unknown }[] = []

    class SlowEvaluator extends Evaluator {
      static evaluatorName = 'SlowEvaluatorWithDropError'

      async evaluate(): Promise<boolean> {
        await slow
        return true
      }
    }

    const evaluator = new OnlineEvaluator({
      evaluator: new SlowEvaluator(),
      maxConcurrency: 1,
      onMaxConcurrency: () => {
        throw new Error('drop hook boom')
      },
    })
    const fn = withOnlineEvaluation(async () => 'x', {
      evaluators: [evaluator],
      onError: (_error, context, droppedEvaluator, location) => {
        errors.push({ evaluator: droppedEvaluator, location, output: context.output })
      },
      target: 'slow-target',
    })

    await withMemoryLogExporter(async () => {
      await fn()
      await fn()
      releaseSlow()
      await waitForEvaluations()
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.evaluator).toBeInstanceOf(SlowEvaluator)
    expect(errors[0]?.location).toBe('on_max_concurrency')
    expect(errors[0]?.output).toBe('x')
  })

  it('waitForEvaluations times out when dispatches remain pending', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })

    class SlowEvaluator extends Evaluator {
      static evaluatorName = 'SlowTimeoutEvaluator'
      async evaluate(): Promise<boolean> {
        await slow
        return true
      }
    }

    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new SlowEvaluator()], target: 'timeout-target' })

    await withMemoryLogExporter(async () => {
      await fn()
      await expect(waitForEvaluations({ timeoutMs: 0 })).rejects.toThrow('waitForEvaluations:')
      releaseSlow()
      await waitForEvaluations()
    })
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

describe('sampling', () => {
  it('passes a SamplingContext with args and target to the sampleRate callable', async () => {
    const seen: { args: unknown[]; target: string }[] = []
    const fn = withOnlineEvaluation(async (a: number, b: string) => `${a.toString()}:${b}`, {
      evaluators: [new AlwaysPass()],
      sampleRate: (ctx) => {
        seen.push({ args: ctx.args, target: ctx.target })
        return 1
      },
      target: 'sampling-ctx-target',
    })
    await withMemoryLogExporter(async () => {
      await fn(7, 'q')
      await waitForEvaluations()
    })
    expect(seen).toEqual([{ args: [7, 'q'], target: 'sampling-ctx-target' }])
  })

  it('correlated sampling mode shares a single draw across evaluators in one call', async () => {
    // Math.random gets called multiple times per fn() (sampling seed + exporter id + spans).
    // Use a counter to give the sampling seed a known value and a benign default for the rest.
    let calls = 0
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      calls += 1
      if (calls === 1) return 0.4 // first call sampling seed → < 0.5, both included
      if (calls === 2) return 0.99 // exporter id, ignored
      if (calls === 3) return 0.6 // second call sampling seed → ≥ 0.5, both excluded
      return 0.99
    })
    try {
      const fn = withOnlineEvaluation(async () => 'x', {
        evaluators: [new AlwaysPass(), new AlwaysFail()],
        sampleRate: 0.5,
        samplingMode: 'correlated',
        target: 'correlated',
      })
      const { logs } = await withMemoryLogExporter(async () => {
        await fn()
        await fn()
        await waitForEvaluations()
      })
      expect(logs).toHaveLength(2)
      expect(logs.map((l) => l.attributes[GEN_AI_EVAL_NAME]).sort()).toEqual(['AlwaysFail', 'AlwaysPass'])
    } finally {
      random.mockRestore()
    }
  })

  it('configureOnlineEvals({samplingMode}) applies globally', async () => {
    configureOnlineEvals({ samplingMode: 'correlated' })
    let calls = 0
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      calls += 1
      if (calls === 1) return 0.1 // sampling seed → < 0.5, both included
      return 0.99
    })
    try {
      const fn = withOnlineEvaluation(async () => 'x', {
        evaluators: [new AlwaysPass(), new AlwaysFail()],
        sampleRate: 0.5,
        target: 'correlated-global',
      })
      const { logs } = await withMemoryLogExporter(async () => {
        await fn()
        await waitForEvaluations()
      })
      expect(logs).toHaveLength(2)
    } finally {
      random.mockRestore()
      configureOnlineEvals({ samplingMode: 'independent' })
    }
  })
})

describe('evaluator output edge cases', () => {
  it('an evaluator returning an empty result map emits no events', async () => {
    class EmptyResult extends Evaluator {
      static evaluatorName = 'EmptyResult'
      evaluate(): Record<string, never> {
        return {}
      }
    }
    const fn = withOnlineEvaluation(async () => 'x', { evaluators: [new EmptyResult()], target: 'empty-result' })
    const { logs } = await withMemoryLogExporter(async () => {
      await fn()
      await waitForEvaluations()
    })
    expect(logs).toHaveLength(0)
  })
})

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
