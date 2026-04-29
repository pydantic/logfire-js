/**
 * Online evaluation HOF. Wraps a function so each invocation:
 *   1. opens a "call span" on the `pydantic-evals` scope
 *   2. runs the function
 *   3. (after the span closes) dispatches the configured evaluators in the
 *      background, gated by sampling and per-evaluator concurrency limits
 *   4. emits one `gen_ai.evaluation.result` log event per evaluator result /
 *      failure, parented to the call span via a `NonRecordingSpan` context
 *
 * Mirrors pydantic-evals' `online.py` + `_online.py`.
 */

import { context as ContextAPI, propagation, trace as TraceAPI, TraceFlags } from '@opentelemetry/api'

import type { Evaluator } from './Evaluator'
import type { EvaluationResultJson, EvaluatorContext, EvaluatorFailureRecord, EvaluatorOutput } from './types'

import { ATTR_EVALUATOR_NAME, SPAN_MSG_TEMPLATE_EVALUATOR, SPAN_NAME_EVALUATOR_LITERAL } from './constants'
import { getCurrentTaskRun } from './currentTaskRun'
import { extractMetricsFromSpanTree } from './extractMetrics'
import { evalsSpan } from './internal'
import { buildEvaluationResultJson, emitEvaluationResult, emitEvaluatorFailure, spanReferenceFromSpan } from './otelEmit'
import { Semaphore } from './Semaphore'
import { buildSpanTree, getEvalsSpanProcessor, SpanTree, SpanTreeRecordingError } from './spanTree'

export type SamplingMode = 'correlated' | 'independent'

export interface SamplingContext {
  args: unknown[]
  target: string
}

export interface SinkPayload {
  context: EvaluatorContext
  failures: EvaluatorFailureRecord[]
  results: EvaluationResultJson[]
  spanReference: null | { spanId: string; traceId: string }
  target: string
}

export type EvaluationSink = (payload: SinkPayload) => Promise<void> | void

export interface OnlineEvalConfig {
  emitOtelEvents: boolean
  enabled: boolean
  includeBaggage: boolean
  metadata?: Record<string, unknown>
  onError?: (e: unknown, evaluatorName: string) => void
  onMaxConcurrency?: (evaluatorName: string) => void
  onSamplingError?: (e: unknown) => void
  sampleRate: ((ctx: SamplingContext) => boolean | number) | number
  samplingMode: SamplingMode
  sink?: EvaluationSink
}

const DEFAULT_CONFIG: OnlineEvalConfig = {
  emitOtelEvents: true,
  enabled: true,
  includeBaggage: true,
  sampleRate: 1.0,
  samplingMode: 'correlated',
}

/** Mutate the process-wide online-eval defaults. */
export function configureOnlineEvals(opts: Partial<OnlineEvalConfig>): void {
  Object.assign(DEFAULT_CONFIG, opts)
}

export function getOnlineEvalConfig(): Readonly<OnlineEvalConfig> {
  return DEFAULT_CONFIG
}

interface OnlineEvaluatorOptions {
  evaluator: Evaluator
  maxConcurrency?: number
  onError?: (e: unknown, evaluatorName: string) => void
  onMaxConcurrency?: (evaluatorName: string) => void
  sampleRate?: number
  sink?: EvaluationSink
}

export class OnlineEvaluator {
  readonly sampleRate?: number
  readonly sink?: EvaluationSink
  get evaluator(): Evaluator {
    return this.inner
  }
  get name(): string {
    return this.inner.getResultName()
  }
  private readonly inner: Evaluator
  private readonly maxConcurrencySem: Semaphore

  private readonly onError?: (e: unknown, evaluatorName: string) => void

  private readonly onMaxConcurrency?: (evaluatorName: string) => void

  constructor(opts: OnlineEvaluatorOptions) {
    this.inner = opts.evaluator
    this.maxConcurrencySem = new Semaphore(opts.maxConcurrency ?? 10)
    this.onError = opts.onError
    this.onMaxConcurrency = opts.onMaxConcurrency
    this.sampleRate = opts.sampleRate
    this.sink = opts.sink
  }

  async tryRun(
    ctx: EvaluatorContext,
    parentSpanRef: null | { spanId: string; traceId: string }
  ): Promise<{ failures: EvaluatorFailureRecord[]; results: EvaluationResultJson[] }> {
    const release = this.maxConcurrencySem.tryAcquire()
    if (release === null) {
      this.onMaxConcurrency?.(this.name)
      return { failures: [], results: [] }
    }
    try {
      const out = await runWithParentSpanContext(parentSpanRef, () =>
        evalsSpan(
          SPAN_MSG_TEMPLATE_EVALUATOR,
          {
            attributes: { [ATTR_EVALUATOR_NAME]: this.name },
            spanName: SPAN_NAME_EVALUATOR_LITERAL,
          },
          async () => this.inner.evaluate(ctx)
        )
      )
      return processOutput(out, this.inner)
    } catch (err) {
      this.onError?.(err, this.name)
      return { failures: [buildFailureRecord(err, this.name, this.inner.getSpec(), this.inner.evaluatorVersion)], results: [] }
    } finally {
      release()
    }
  }
}

interface WithOnlineOptions {
  emitOtelEvents?: boolean
  evaluators: readonly (Evaluator | OnlineEvaluator)[]
  extractArgs?: boolean | readonly string[]
  includeBaggage?: boolean
  msgTemplate?: string
  onError?: (e: unknown, evaluatorName: string) => void
  onMaxConcurrency?: (evaluatorName: string) => void
  onSamplingError?: (e: unknown) => void
  recordReturn?: boolean
  sampleRate?: ((ctx: SamplingContext) => boolean | number) | number
  samplingMode?: SamplingMode
  sink?: EvaluationSink
  spanName?: string
  target?: string
}

const pendingEvaluations = new Set<Promise<unknown>>()

/** Suppression flag for nested calls inside `Dataset.evaluate`. */
let suppressDispatch = 0
export function disableEvaluation(): { dispose(): void } {
  suppressDispatch += 1
  return {
    dispose(): void {
      suppressDispatch = Math.max(0, suppressDispatch - 1)
    },
  }
}

/** Wait for any in-flight online-eval dispatches to settle. Test-only utility. */
export async function waitForEvaluations(opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  while (pendingEvaluations.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(`waitForEvaluations: ${pendingEvaluations.size.toString()} dispatches still pending after ${timeoutMs.toString()}ms`)
    }
    await Promise.race([Promise.allSettled(Array.from(pendingEvaluations)), new Promise((resolve) => setTimeout(resolve, 50))])
  }
}

/**
 * Wrap an async function with online evaluation. Each call opens a span; after
 * the span closes, configured evaluators run in the background.
 *
 * Online evals only support **async-returning** functions. Python pydantic-evals
 * has a sync→thread fallback; we type-restrict away from it because JS
 * concurrency doesn't model that path cleanly.
 */
export function withOnlineEvaluation<F extends (...args: never[]) => Promise<unknown>>(fn: F, opts: WithOnlineOptions): F {
  const target = opts.target ?? (fn.name === '' ? 'task' : fn.name)
  const msgTemplate = opts.msgTemplate ?? `Calling ${target}`
  const spanName = opts.spanName ?? msgTemplate

  const onlineEvaluators = opts.evaluators.map((e) => (e instanceof OnlineEvaluator ? e : new OnlineEvaluator({ evaluator: e })))

  const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const callFn = (): Promise<unknown> => Promise.resolve((fn as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args))
    if (suppressDispatch > 0) return callFn()
    if (getCurrentTaskRun() !== undefined) {
      // We're inside a Dataset.evaluate task. Don't double-dispatch online evals.
      return callFn()
    }

    const cfg = DEFAULT_CONFIG
    if (!cfg.enabled) return callFn()

    const samplingCtx: SamplingContext = { args, target }
    const sampledEvaluators = sampleEvaluators(onlineEvaluators, opts, cfg, samplingCtx)
    if (sampledEvaluators.length === 0) return callFn()

    const callAttrs: Record<string, unknown> = { target }
    if (opts.extractArgs !== undefined && opts.extractArgs !== false) {
      const argNames: readonly string[] = Array.isArray(opts.extractArgs)
        ? opts.extractArgs
        : extractParamNames(fn as unknown as (...args: unknown[]) => unknown)
      for (let i = 0; i < args.length; i++) {
        const argName: string = argNames[i] ?? `arg${i.toString()}`
        callAttrs[argName] = args[i]
      }
    }

    let output: unknown
    let durationSec = 0
    const start = performance.now() / 1000
    const baggageAttrs: Record<string, unknown> = {}
    if (opts.includeBaggage ?? cfg.includeBaggage) {
      const baggage = propagation.getActiveBaggage()
      if (baggage !== undefined) {
        for (const [k, entry] of baggage.getAllEntries()) {
          baggageAttrs[k] = entry.value
        }
      }
    }

    const evalsProcessor = getEvalsSpanProcessor()
    const exporterContextId = buildOnlineExporterContextId()
    evalsProcessor.openBucket(exporterContextId)

    let callSpanRef: { spanId: string; traceId: string }
    try {
      callSpanRef = await evalsProcessor.runWithBucket(exporterContextId, () =>
        evalsSpan(msgTemplate, { attributes: callAttrs, spanName }, async (span) => {
          const ref = spanReferenceFromSpan(span)
          try {
            output = await callFn()
            if (opts.recordReturn === true) {
              span.setAttribute('return', JSON.stringify(output))
            }
            return ref
          } finally {
            durationSec = performance.now() / 1000 - start
          }
        })
      )
    } catch (err) {
      evalsProcessor.drainBucket(exporterContextId)
      throw err
    }

    const capturedSpans = evalsProcessor.drainBucket(exporterContextId)
    const spanTree =
      capturedSpans.length === 0 && !isProcessorInstalledOnGlobal()
        ? buildSpanTree([], new SpanTreeRecordingError())
        : buildSpanTree(capturedSpans, null)
    const metrics: Record<string, number> = {}
    extractMetricsFromSpanTree(spanTree, metrics)

    // Dispatch evaluators in the background — don't await, but track for tests.
    const dispatch = dispatchEvaluators({
      args,
      baggageAttrs,
      callSpanRef,
      cfg,
      durationSec,
      metrics,
      output,
      sampledEvaluators,
      spanTree,
      target,
      userOptions: opts,
    })
    pendingEvaluations.add(dispatch)
    dispatch.finally(() => pendingEvaluations.delete(dispatch)).catch(() => undefined)

    return output
  }
  return wrapped as unknown as F
}

function sampleEvaluators(
  evaluators: readonly OnlineEvaluator[],
  opts: WithOnlineOptions,
  cfg: OnlineEvalConfig,
  ctx: SamplingContext
): OnlineEvaluator[] {
  const baseRate = opts.sampleRate ?? cfg.sampleRate
  const mode = opts.samplingMode ?? cfg.samplingMode
  const onSamplingError = opts.onSamplingError ?? cfg.onSamplingError

  let baseRateNum: number
  try {
    if (typeof baseRate === 'function') {
      const r = baseRate(ctx)
      baseRateNum = typeof r === 'boolean' ? (r ? 1 : 0) : r
    } else {
      baseRateNum = baseRate
    }
  } catch (err) {
    onSamplingError?.(err)
    return []
  }

  const correlatedSeed = mode === 'correlated' ? Math.random() : null
  return evaluators.filter((ev) => {
    const rate = ev.sampleRate ?? baseRateNum
    if (rate <= 0) return false
    if (rate >= 1) return true
    const draw = correlatedSeed ?? Math.random()
    return draw < rate
  })
}

interface DispatchArgs {
  args: unknown[]
  baggageAttrs: Record<string, unknown>
  callSpanRef: { spanId: string; traceId: string }
  cfg: OnlineEvalConfig
  durationSec: number
  metrics: Record<string, number>
  output: unknown
  sampledEvaluators: OnlineEvaluator[]
  spanTree: SpanTree
  target: string
  userOptions: WithOnlineOptions
}

async function dispatchEvaluators(args: DispatchArgs): Promise<void> {
  const ctx: EvaluatorContext = {
    attributes: {},
    duration: args.durationSec,
    inputs: args.args.length === 1 ? args.args[0] : args.args,
    metrics: args.metrics,
    name: undefined,
    output: args.output,
    spanTree: args.spanTree,
  }

  const allResults: EvaluationResultJson[] = []
  const allFailures: EvaluatorFailureRecord[] = []
  for (const ev of args.sampledEvaluators) {
    const { failures, results } = await ev.tryRun(ctx, args.callSpanRef)
    allResults.push(...results)
    allFailures.push(...failures)
  }

  const emitOtel = args.userOptions.emitOtelEvents ?? args.cfg.emitOtelEvents
  if (emitOtel) {
    for (const r of allResults)
      emitEvaluationResult(r, { baggageAttrs: args.baggageAttrs, parentSpanRef: args.callSpanRef, target: args.target })
    for (const f of allFailures)
      emitEvaluatorFailure(f, { baggageAttrs: args.baggageAttrs, parentSpanRef: args.callSpanRef, target: args.target })
  }

  const sink = args.userOptions.sink ?? args.cfg.sink
  if (sink !== undefined) {
    await sink({
      context: ctx,
      failures: allFailures,
      results: allResults,
      spanReference: args.callSpanRef,
      target: args.target,
    })
  }
}

function buildOnlineExporterContextId(): string {
  return `online-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isProcessorInstalledOnGlobal(): boolean {
  const tp = TraceAPI.getTracerProvider()
  return typeof tp === 'object' && tp.constructor.name !== 'NoopTracerProvider' && tp.constructor.name !== 'ProxyTracerProvider'
}

function processOutput(
  raw: EvaluatorOutput,
  evaluator: Evaluator
): { failures: EvaluatorFailureRecord[]; results: EvaluationResultJson[] } {
  const results: EvaluationResultJson[] = []
  const spec = evaluator.getSpec()
  if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string' || isReason(raw)) {
    results.push(buildEvaluationResultJson(evaluator.getResultName(), raw, spec, evaluator.evaluatorVersion))
  } else {
    for (const [name, val] of Object.entries(raw)) {
      results.push(buildEvaluationResultJson(name, val, spec, evaluator.evaluatorVersion))
    }
  }
  return { failures: [], results }
}

function isReason(v: unknown): v is { reason?: string; value: boolean | number | string } {
  return typeof v === 'object' && v !== null && 'value' in v && !Array.isArray(v)
}

function buildFailureRecord(
  err: unknown,
  name: string,
  spec: ReturnType<Evaluator['getSpec']>,
  evaluatorVersion?: string
): EvaluatorFailureRecord {
  const isErr = err instanceof Error
  const out: EvaluatorFailureRecord = {
    error_message: isErr ? err.message : String(err),
    error_type: isErr ? err.constructor.name : 'Error',
    name,
    source: spec,
  }
  if (isErr && err.stack !== undefined) out.error_stacktrace = err.stack
  if (evaluatorVersion !== undefined) out.evaluator_version = evaluatorVersion
  return out
}

function runWithParentSpanContext<R>(parentSpanRef: null | { spanId: string; traceId: string }, fn: () => R): R {
  if (parentSpanRef === null) return fn()
  const parentContext = TraceAPI.setSpanContext(ContextAPI.active(), {
    isRemote: false,
    spanId: parentSpanRef.spanId,
    traceFlags: TraceFlags.SAMPLED,
    traceId: parentSpanRef.traceId,
  })
  return ContextAPI.with(parentContext, fn)
}

function extractParamNames(fn: (...args: unknown[]) => unknown): string[] {
  const src = fn.toString()
  // Crude — handles `function name(a, b)`, `(a, b) => ...`, and `async (a, b) => ...`.
  const match = /^(?:async\s+)?(?:function[^(]*)?\(([^)]*)\)/.exec(src)
  if (match === null) return []
  const inside = match[1]?.trim() ?? ''
  if (inside === '') return []
  return inside.split(',').map((p) => {
    const trimmed = p.trim()
    // strip default values, type annotations, destructuring renames
    return trimmed.replace(/[=:].*$/, '').trim()
  })
}
