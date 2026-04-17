import { getCurrentTaskRun } from './dataset'
import { EvaluatorContext } from './evaluators/context'
import { EvaluationResult, Evaluator, EvaluatorFailure } from './evaluators/evaluator'
import { runEvaluator } from './evaluators/runEvaluator'
import { contextSubtreeCapture } from './otel/contextSubtree'
import { SpanTreeRecordingError } from './otel/errors'
import { SpanTree } from './otel/spanTree'

export type OnErrorLocation = 'on_max_concurrency' | 'sink'
export type SamplingMode = 'correlated' | 'independent'

export interface SamplingContext {
  callSeed: number
  evaluator: Evaluator
  inputs: unknown
  metadata: null | Record<string, unknown>
}

export type OnMaxConcurrencyCallback = (ctx: EvaluatorContext) => Promise<void> | void
export type OnSamplingErrorCallback = (error: Error, evaluator: Evaluator) => void
export type OnErrorCallback = (error: Error, ctx: EvaluatorContext, evaluator: Evaluator, location: OnErrorLocation) => Promise<void> | void

export interface SpanReference {
  spanId: string
  traceId: string
}

export type SinkCallback = (
  results: readonly EvaluationResult[],
  failures: readonly EvaluatorFailure[],
  context: EvaluatorContext
) => Promise<void> | void

export interface EvaluationSink {
  submit: (params: {
    context: EvaluatorContext
    failures: readonly EvaluatorFailure[]
    results: readonly EvaluationResult[]
    spanReference: null | SpanReference
  }) => Promise<void>
}

export class CallbackSink implements EvaluationSink {
  private readonly callback: SinkCallback

  constructor(callback: SinkCallback) {
    this.callback = callback
  }

  async submit(params: {
    context: EvaluatorContext
    failures: readonly EvaluatorFailure[]
    results: readonly EvaluationResult[]
    spanReference: null | SpanReference
  }): Promise<void> {
    const r = this.callback(params.results, params.failures, params.context)
    if (r instanceof Promise) await r
  }
}

function isEvaluationSink(value: unknown): value is EvaluationSink {
  return value !== null && typeof value === 'object' && 'submit' in value && typeof (value as { submit: unknown }).submit === 'function'
}

function normalizeSink(sink: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[]): EvaluationSink[] {
  if (sink === null) return []
  if (Array.isArray(sink)) return sink.map((s) => (isEvaluationSink(s) ? s : new CallbackSink(s)))
  if (isEvaluationSink(sink)) return [sink]
  return [new CallbackSink(sink)]
}

export interface OnlineEvaluatorOptions {
  evaluator: Evaluator
  maxConcurrency?: number
  onError?: null | OnErrorCallback
  onMaxConcurrency?: null | OnMaxConcurrencyCallback
  onSamplingError?: null | OnSamplingErrorCallback
  sampleRate?: ((ctx: SamplingContext) => boolean | number) | null | number
  sink?: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[]
}

export class OnlineEvaluator {
  readonly evaluator: Evaluator
  readonly maxConcurrency: number
  readonly onError: null | OnErrorCallback
  readonly onMaxConcurrency: null | OnMaxConcurrencyCallback
  readonly onSamplingError: null | OnSamplingErrorCallback
  readonly sampleRate: ((ctx: SamplingContext) => boolean | number) | null | number
  readonly sink: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[]
  private currentCount = 0

  constructor(options: OnlineEvaluatorOptions) {
    this.evaluator = options.evaluator
    this.sampleRate = options.sampleRate ?? null
    this.maxConcurrency = options.maxConcurrency ?? 10
    this.sink = options.sink ?? null
    this.onMaxConcurrency = options.onMaxConcurrency ?? null
    this.onSamplingError = options.onSamplingError ?? null
    this.onError = options.onError ?? null
  }

  acquire(): boolean {
    if (this.currentCount >= this.maxConcurrency) return false
    this.currentCount++
    return true
  }

  release(): void {
    this.currentCount--
  }
}

export interface OnlineEvalConfigOptions {
  defaultSampleRate?: ((ctx: SamplingContext) => boolean | number) | number
  defaultSink?: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[]
  enabled?: boolean
  metadata?: null | Record<string, unknown>
  onError?: null | OnErrorCallback
  onMaxConcurrency?: null | OnMaxConcurrencyCallback
  onSamplingError?: null | OnSamplingErrorCallback
  samplingMode?: SamplingMode
}

const backgroundPromises = new Set<Promise<void>>()
let evaluationDisabled = 0

export function disableEvaluation<T>(fn: () => Promise<T> | T): Promise<T> | T {
  evaluationDisabled++
  try {
    const r = fn()
    if (r instanceof Promise) {
      return r.finally(() => {
        evaluationDisabled--
      })
    }
    evaluationDisabled--
    return r
  } catch (e) {
    evaluationDisabled--
    throw e
  }
}

export async function waitForEvaluations(): Promise<void> {
  while (backgroundPromises.size > 0) {
    await Promise.all(Array.from(backgroundPromises))
  }
}

export class OnlineEvalConfig {
  defaultSampleRate: ((ctx: SamplingContext) => boolean | number) | number
  defaultSink: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[]
  enabled: boolean
  metadata: null | Record<string, unknown>
  onError: null | OnErrorCallback
  onMaxConcurrency: null | OnMaxConcurrencyCallback
  onSamplingError: null | OnSamplingErrorCallback
  samplingMode: SamplingMode

  constructor(options: OnlineEvalConfigOptions = {}) {
    this.defaultSink = options.defaultSink ?? null
    this.defaultSampleRate = options.defaultSampleRate ?? 1.0
    this.samplingMode = options.samplingMode ?? 'independent'
    this.enabled = options.enabled ?? true
    this.metadata = options.metadata ?? null
    this.onMaxConcurrency = options.onMaxConcurrency ?? null
    this.onSamplingError = options.onSamplingError ?? null
    this.onError = options.onError ?? null
  }

  evaluate<F extends (...args: never[]) => unknown>(...evaluators: (Evaluator | OnlineEvaluator)[]): (fn: F) => F {
    const onlineEvals = evaluators.map((e) => (e instanceof OnlineEvaluator ? e : new OnlineEvaluator({ evaluator: e })))
    return (fn: F): F => {
      const wrapped = ((...args: Parameters<F>) => {
        if (!this.enabled || evaluationDisabled > 0 || getCurrentTaskRun() !== null) {
          return fn(...(args as never[]))
        }
        return this.runWrapped(fn, onlineEvals, args)
      }) as F
      return wrapped
    }
  }

  private dispatchEvaluator(
    online: OnlineEvaluator,
    context: EvaluatorContext,
    spanReference: null | SpanReference,
    sinks: EvaluationSink[]
  ): Promise<void> {
    const onMaxConc = online.onMaxConcurrency ?? this.onMaxConcurrency
    const onErr = online.onError ?? this.onError
    if (!online.acquire()) {
      if (onMaxConc !== null) {
        const callAndCatch = async () => {
          try {
            const r = onMaxConc(context)
            if (r instanceof Promise) await r
          } catch (e) {
            await callOnError(onErr, e as Error, context, online.evaluator, 'on_max_concurrency')
          }
        }
        return callAndCatch()
      }
      return Promise.resolve()
    }
    const work = async () => {
      try {
        const raw = await runEvaluator(online.evaluator, context)
        const results = Array.isArray(raw) ? raw : []
        const failures = Array.isArray(raw) ? [] : [raw]
        await Promise.all(
          sinks.map(async (sink) => {
            try {
              await sink.submit({ context, failures, results, spanReference })
            } catch (e) {
              await callOnError(onErr, e as Error, context, online.evaluator, 'sink')
            }
          })
        )
      } finally {
        online.release()
      }
    }
    return work()
  }

  private async runWrapped<F extends (...args: never[]) => unknown>(
    fn: F,
    onlineEvals: OnlineEvaluator[],
    args: Parameters<F>
  ): Promise<Awaited<ReturnType<F>>> {
    const inputs = Array.from(args) as unknown
    const callSeed = Math.random()
    const sampled: OnlineEvaluator[] = []
    for (const oe of onlineEvals) {
      const rate = oe.sampleRate ?? this.defaultSampleRate
      const sampleCtx: SamplingContext = { callSeed, evaluator: oe.evaluator, inputs, metadata: this.metadata }
      try {
        const resolved = typeof rate === 'function' ? rate(sampleCtx) : rate
        if (this.shouldEvaluate(resolved, sampleCtx)) sampled.push(oe)
      } catch (e) {
        const handler = oe.onSamplingError ?? this.onSamplingError
        if (handler !== null) {
          try {
            handler(e as Error, oe.evaluator)
          } catch {
            // suppress
          }
        } else {
          throw e
        }
      }
    }
    if (sampled.length === 0) return (await Promise.resolve(fn(...(args as never[])))) as Awaited<ReturnType<F>>

    let output: Awaited<ReturnType<F>>
    let duration: number
    let spanTreeRef: SpanTree | SpanTreeRecordingError = new SpanTreeRecordingError('not-captured')
    await contextSubtreeCapture(async (getTree) => {
      const t0 = performance.now()
      output = (await Promise.resolve(fn(...(args as never[])))) as Awaited<ReturnType<F>>
      duration = (performance.now() - t0) / 1000
      spanTreeRef = getTree()
    })
    const context = new EvaluatorContext({
      attributes: {},
      duration: duration!,
      expectedOutput: null,
      inputs,
      metadata: this.metadata,
      metrics: {},
      name: null,
      output: output!,
      spanTree: spanTreeRef,
    })

    const spanReference: null | SpanReference = null

    const dispatch = async () => {
      await Promise.all(
        sampled.map((oe) => {
          const sinks = normalizeSink(oe.sink ?? this.defaultSink)
          if (sinks.length === 0) return Promise.resolve()
          return this.dispatchEvaluator(oe, context, spanReference, sinks)
        })
      )
    }
    const promise = dispatch()
    backgroundPromises.add(promise)
    promise.finally(() => backgroundPromises.delete(promise))

    return output!
  }

  private shouldEvaluate(resolved: boolean | number, sampleCtx: SamplingContext): boolean {
    if (!this.enabled) return false
    if (evaluationDisabled > 0) return false
    if (typeof resolved === 'boolean') return resolved
    if (resolved >= 1) return true
    if (resolved <= 0) return false
    if (this.samplingMode === 'correlated') return sampleCtx.callSeed < resolved
    return Math.random() < resolved
  }
}

async function callOnError(
  onError: null | OnErrorCallback,
  error: Error,
  context: EvaluatorContext,
  evaluator: Evaluator,
  location: OnErrorLocation
): Promise<void> {
  if (onError === null) return
  try {
    const r = onError(error, context, evaluator, location)
    if (r instanceof Promise) await r
  } catch {
    // suppress
  }
}

export const DEFAULT_CONFIG = new OnlineEvalConfig()

export function evaluate<F extends (...args: never[]) => unknown>(...evaluators: (Evaluator | OnlineEvaluator)[]): (fn: F) => F {
  return DEFAULT_CONFIG.evaluate<F>(...evaluators)
}

export function configure(options: OnlineEvalConfigOptions): void {
  if (options.defaultSink !== undefined) DEFAULT_CONFIG.defaultSink = options.defaultSink
  if (options.defaultSampleRate !== undefined) DEFAULT_CONFIG.defaultSampleRate = options.defaultSampleRate
  if (options.samplingMode !== undefined) DEFAULT_CONFIG.samplingMode = options.samplingMode
  if (options.enabled !== undefined) DEFAULT_CONFIG.enabled = options.enabled
  if (options.metadata !== undefined) DEFAULT_CONFIG.metadata = options.metadata
  if (options.onMaxConcurrency !== undefined) DEFAULT_CONFIG.onMaxConcurrency = options.onMaxConcurrency
  if (options.onSamplingError !== undefined) DEFAULT_CONFIG.onSamplingError = options.onSamplingError
  if (options.onError !== undefined) DEFAULT_CONFIG.onError = options.onError
}

export async function runEvaluators(
  evaluators: Evaluator[],
  context: EvaluatorContext
): Promise<{ failures: EvaluatorFailure[]; results: EvaluationResult[] }> {
  const allResults: EvaluationResult[] = []
  const allFailures: EvaluatorFailure[] = []
  const raw = await Promise.all(evaluators.map((e) => runEvaluator(e, context)))
  for (const r of raw) {
    if (Array.isArray(r)) allResults.push(...r)
    else allFailures.push(r)
  }
  return { failures: allFailures, results: allResults }
}
