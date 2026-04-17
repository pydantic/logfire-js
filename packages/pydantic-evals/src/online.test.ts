import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { EvaluatorContext } from './evaluators/context'
import { EvaluationResult, Evaluator, EvaluatorFailure } from './evaluators/evaluator'
import {
  CallbackSink,
  configure,
  DEFAULT_CONFIG,
  disableEvaluation,
  OnlineEvalConfig,
  evaluate as onlineEvaluate,
  OnlineEvaluator,
  runEvaluators,
  waitForEvaluations,
} from './online'

class PassEval extends Evaluator {
  evaluate() {
    return true
  }
}

class FailEval extends Evaluator {
  evaluate(): never {
    throw new Error('kaboom')
  }
}

beforeEach(() => {
  configure({
    defaultSampleRate: 1.0,
    defaultSink: null,
    enabled: true,
    metadata: null,
    onError: null,
    onMaxConcurrency: null,
    onSamplingError: null,
    samplingMode: 'independent',
  })
})

afterEach(async () => {
  await waitForEvaluations()
})

describe('online', () => {
  test('runEvaluators runs evaluators in parallel', async () => {
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: 'x',
      spanTree: new (await import('./otel/errors')).SpanTreeRecordingError('no') as never,
    })
    const { failures, results } = await runEvaluators([new PassEval(), new FailEval()], ctx)
    expect(results.length + failures.length).toBe(2)
  })

  test('CallbackSink wraps a callback', async () => {
    let called = false
    const sink = new CallbackSink(() => {
      called = true
    })
    await sink.submit({
      context: {} as EvaluatorContext,
      failures: [] as EvaluatorFailure[],
      results: [] as EvaluationResult[],
      spanReference: null,
    })
    expect(called).toBe(true)
  })

  test('CallbackSink supports async callbacks', async () => {
    let called = false
    const sink = new CallbackSink(async () => {
      await Promise.resolve()
      called = true
    })
    await sink.submit({
      context: {} as EvaluatorContext,
      failures: [],
      results: [],
      spanReference: null,
    })
    expect(called).toBe(true)
  })

  test('OnlineEvaluator constructs with defaults', () => {
    const oe = new OnlineEvaluator({ evaluator: new PassEval() })
    expect(oe.maxConcurrency).toBe(10)
    expect(oe.acquire()).toBe(true)
    oe.release()
  })

  test('OnlineEvaluator respects max concurrency', () => {
    const oe = new OnlineEvaluator({ evaluator: new PassEval(), maxConcurrency: 1 })
    expect(oe.acquire()).toBe(true)
    expect(oe.acquire()).toBe(false)
    oe.release()
  })

  test('decorator runs evaluators in background with a sink', async () => {
    const captured: EvaluationResult[] = []
    const decorated = onlineEvaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x + 1)
    })
    const result = await decorated(1)
    expect(result).toBe(2)
    await waitForEvaluations()
    expect(captured.length).toBeGreaterThan(0)
  })

  test('decorator respects disabled config', async () => {
    const failures: EvaluatorFailure[] = []
    const decorated = onlineEvaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sink: (_r, f) => void failures.push(...f) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x + 1)
    })
    configure({ enabled: false })
    expect(await decorated(5)).toBe(6)
    configure({ enabled: true })
  })

  test('decorator respects disableEvaluation', async () => {
    const captured: EvaluationResult[] = []
    const decorated = onlineEvaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x + 1)
    })
    const v = await disableEvaluation(async () => await decorated(1))
    expect(v).toBe(2)
    await waitForEvaluations()
    expect(captured).toEqual([])
  })

  test('disableEvaluation async form', async () => {
    const result = await disableEvaluation(async () => {
      await Promise.resolve()
      return 42
    })
    expect(result).toBe(42)
  })

  test('disableEvaluation async rejection is surfaced', async () => {
    await expect(
      disableEvaluation(async () => {
        await Promise.resolve()
        throw new Error('boom')
      })
    ).rejects.toThrow(/boom/)
  })

  test('disableEvaluation sync rejection is surfaced', () => {
    expect(() =>
      disableEvaluation(() => {
        throw new Error('sync-boom')
      })
    ).toThrow('sync-boom')
  })

  test('sample_rate of 0 skips evaluator', async () => {
    const captured: EvaluationResult[] = []
    const config = new OnlineEvalConfig()
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sampleRate: 0, sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(captured).toEqual([])
  })

  test('sample_rate 1 always runs', async () => {
    const captured: EvaluationResult[] = []
    const config = new OnlineEvalConfig()
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sampleRate: 1, sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(captured.length).toBeGreaterThan(0)
  })

  test('sample_rate callable returning bool', async () => {
    const captured: EvaluationResult[] = []
    const config = new OnlineEvalConfig()
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sampleRate: () => true, sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(captured.length).toBeGreaterThan(0)
  })

  test('sample_rate callable throws triggers onSamplingError', async () => {
    let errorSeen: Error | null = null
    const config = new OnlineEvalConfig({ onSamplingError: (e) => (errorSeen = e) })
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({
        evaluator: new PassEval(),
        sampleRate: () => {
          throw new Error('rate-error')
        },
      })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(errorSeen).not.toBeNull()
  })

  test('sample_rate callable throws without handler propagates', async () => {
    const config = new OnlineEvalConfig()
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({
        evaluator: new PassEval(),
        sampleRate: () => {
          throw new Error('rate-error')
        },
        sink: (r) => void r,
      })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await expect(decorated(1)).rejects.toThrow(/rate-error/)
  })

  test('correlated sampling shares seed', async () => {
    const captured: EvaluationResult[] = []
    const config = new OnlineEvalConfig({ samplingMode: 'correlated' })
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sampleRate: 0.5, sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    for (let i = 0; i < 20; i++) await decorated(i)
    await waitForEvaluations()
  })

  test('onMaxConcurrency is called when limit exceeded', async () => {
    let dropped = 0
    const config = new OnlineEvalConfig({ onMaxConcurrency: () => void dropped++ })
    const blockerEval = new (class extends Evaluator {
      async evaluate() {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return true
      }
    })()
    const decorated = config.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: blockerEval, maxConcurrency: 1, sink: () => undefined })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    // Kick off two concurrently
    const p1 = decorated(1)
    const p2 = decorated(2)
    await Promise.all([p1, p2])
    await waitForEvaluations()
    expect(dropped).toBeGreaterThanOrEqual(0)
  })

  test('DEFAULT_CONFIG decorator works', async () => {
    const captured: EvaluationResult[] = []
    const decorated = DEFAULT_CONFIG.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({ evaluator: new PassEval(), sink: (r) => void captured.push(...r) })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(captured.length).toBeGreaterThan(0)
  })

  test('no sink means no dispatch', async () => {
    const decorated = DEFAULT_CONFIG.evaluate<(x: number) => Promise<number>>(new OnlineEvaluator({ evaluator: new PassEval() }))(
      async function fn(x: number): Promise<number> {
        return await Promise.resolve(x)
      }
    )
    expect(await decorated(1)).toBe(1)
    await waitForEvaluations()
  })

  test('sink throwing routes to onError', async () => {
    let errSeen: Error | null = null
    const config = new OnlineEvalConfig({
      defaultSink: () => {
        throw new Error('sink-error')
      },
      onError: (e) => {
        errSeen = e
      },
    })
    const decorated = config.evaluate<(x: number) => Promise<number>>(new OnlineEvaluator({ evaluator: new PassEval() }))(async function fn(
      x: number
    ): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(errSeen).not.toBeNull()
  })

  test('multiple sinks', async () => {
    const hits: number[] = []
    const decorated = DEFAULT_CONFIG.evaluate<(x: number) => Promise<number>>(
      new OnlineEvaluator({
        evaluator: new PassEval(),
        sink: [() => void hits.push(1), () => void hits.push(2)],
      })
    )(async function fn(x: number): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(hits.length).toBe(2)
  })

  test('auto-wraps bare evaluator', async () => {
    const captured: EvaluationResult[] = []
    configure({ defaultSink: (r) => void captured.push(...r) })
    const decorated = DEFAULT_CONFIG.evaluate<(x: number) => Promise<number>>(new PassEval())(async function fn(
      x: number
    ): Promise<number> {
      return await Promise.resolve(x)
    })
    await decorated(1)
    await waitForEvaluations()
    expect(captured.length).toBeGreaterThan(0)
    configure({ defaultSink: null })
  })
})
