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
import { buildEvaluatorFailureRecord, evaluationResultsFromOutput } from './evaluatorResults'
import { extractMetricsFromSpanTree } from './extractMetrics'
import { evalsSpan } from './internal'
import { emitEvaluationResult, emitEvaluatorFailure, type SpanReference, spanReferenceFromSpan } from './otelEmit'
import { Semaphore } from './Semaphore'
import { buildSpanTree, getEvalsSpanProcessor, isProcessorInstalledOnGlobal, SpanTree, SpanTreeRecordingError } from './spanTree'

export type SamplingMode = 'correlated' | 'independent'

export interface SamplingContext {
  args: unknown[]
  target: string
}

export interface SinkPayload {
  context: EvaluatorContext
  failures: EvaluatorFailureRecord[]
  results: EvaluationResultJson[]
  spanReference: null | SpanReference
  target: string
}

export type EvaluationSink = (payload: SinkPayload) => Promise<void> | void
export type OnErrorLocation = 'on_max_concurrency' | 'sink'
export type OnErrorCallback = (
  e: unknown,
  context: EvaluatorContext,
  evaluator: Evaluator,
  location: OnErrorLocation
) => Promise<void> | void
export type OnMaxConcurrencyCallback = (context: EvaluatorContext) => Promise<void> | void

export interface OnlineEvalConfig {
  emitOtelEvents: boolean
  enabled: boolean
  includeBaggage: boolean
  metadata?: Record<string, unknown>
  onError?: OnErrorCallback
  onMaxConcurrency?: OnMaxConcurrencyCallback
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
  samplingMode: 'independent',
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
  onError?: OnErrorCallback
  onMaxConcurrency?: OnMaxConcurrencyCallback
  sampleRate?: number
  sink?: EvaluationSink
}

export class OnlineEvaluator {
  readonly onError?: OnErrorCallback
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

  private readonly onMaxConcurrency?: OnMaxConcurrencyCallback

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
    parentSpanRef: null | SpanReference,
    hooks: { onError?: OnErrorCallback; onMaxConcurrency?: OnMaxConcurrencyCallback } = {}
  ): Promise<{ failures: EvaluatorFailureRecord[]; results: EvaluationResultJson[] }> {
    const release = this.maxConcurrencySem.tryAcquire()
    if (release === null) {
      const onMaxConcurrency = this.onMaxConcurrency ?? hooks.onMaxConcurrency
      if (onMaxConcurrency !== undefined) {
        try {
          await onMaxConcurrency(ctx)
        } catch (err) {
          await reportPipelineError(this.onError ?? hooks.onError, err, ctx, this.inner, 'on_max_concurrency')
        }
      }
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
      return { failures: [buildEvaluatorFailureRecord(err, this.name, this.inner.getSpec(), this.inner.evaluatorVersion)], results: [] }
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
  onError?: OnErrorCallback
  onMaxConcurrency?: OnMaxConcurrencyCallback
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
  const contextArgNames = getContextArgNames(fn as unknown as (...args: unknown[]) => unknown, opts.extractArgs)

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
              span.setAttribute('return', encodeReturnAttribute(output))
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
      inputNames: contextArgNames,
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
  callSpanRef: SpanReference
  cfg: OnlineEvalConfig
  durationSec: number
  inputNames: null | readonly string[]
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
    inputs: buildEvaluatorInputs(args.args, args.inputNames),
    metadata: args.cfg.metadata,
    metrics: args.metrics,
    name: undefined,
    output: args.output,
    spanTree: args.spanTree,
  }

  const emitOtel = args.userOptions.emitOtelEvents ?? args.cfg.emitOtelEvents
  const globalSink = args.userOptions.sink ?? args.cfg.sink
  const hasPerEvaluatorSink = args.sampledEvaluators.some((ev) => ev.sink !== undefined)
  if (!emitOtel && globalSink === undefined && !hasPerEvaluatorSink) return

  const runs = await Promise.all(
    args.sampledEvaluators.map(async (ev) => ({
      ev,
      ...(await ev.tryRun(ctx, args.callSpanRef, {
        onError: args.userOptions.onError ?? args.cfg.onError,
        onMaxConcurrency: args.userOptions.onMaxConcurrency ?? args.cfg.onMaxConcurrency,
      })),
    }))
  )

  const allResults: EvaluationResultJson[] = []
  const allFailures: EvaluatorFailureRecord[] = []
  const perEvaluatorSinks = new Map<
    EvaluationSink,
    { evaluators: Evaluator[]; failures: EvaluatorFailureRecord[]; onError?: OnErrorCallback; results: EvaluationResultJson[] }
  >()
  for (const { ev, failures, results } of runs) {
    allResults.push(...results)
    allFailures.push(...failures)
    if (ev.sink !== undefined) {
      const group = perEvaluatorSinks.get(ev.sink) ?? {
        evaluators: [],
        failures: [],
        onError: ev.onError ?? args.userOptions.onError ?? args.cfg.onError,
        results: [],
      }
      group.evaluators.push(ev.evaluator)
      group.failures.push(...failures)
      group.results.push(...results)
      perEvaluatorSinks.set(ev.sink, group)
    }
  }

  if (emitOtel) {
    for (const r of allResults)
      emitEvaluationResult(r, { baggageAttrs: args.baggageAttrs, parentSpanRef: args.callSpanRef, target: args.target })
    for (const f of allFailures)
      emitEvaluatorFailure(f, { baggageAttrs: args.baggageAttrs, parentSpanRef: args.callSpanRef, target: args.target })
  }

  const sinkSubmissions: Promise<void>[] = []
  for (const [sink, group] of perEvaluatorSinks) {
    sinkSubmissions.push(
      submitSink(
        sink,
        {
          context: ctx,
          failures: group.failures,
          results: group.results,
          spanReference: args.callSpanRef,
          target: args.target,
        },
        group.evaluators,
        group.onError
      )
    )
  }
  if (globalSink !== undefined) {
    sinkSubmissions.push(
      submitSink(
        globalSink,
        {
          context: ctx,
          failures: allFailures,
          results: allResults,
          spanReference: args.callSpanRef,
          target: args.target,
        },
        args.sampledEvaluators.map((ev) => ev.evaluator),
        args.userOptions.onError ?? args.cfg.onError
      )
    )
  }
  await Promise.all(sinkSubmissions)
}

function buildOnlineExporterContextId(): string {
  return `online-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function processOutput(
  raw: EvaluatorOutput,
  evaluator: Evaluator
): { failures: EvaluatorFailureRecord[]; results: EvaluationResultJson[] } {
  return {
    failures: [],
    results: evaluationResultsFromOutput(raw, evaluator.getResultName(), evaluator.getSpec(), evaluator.evaluatorVersion),
  }
}

async function submitSink(
  sink: EvaluationSink,
  payload: SinkPayload,
  evaluators: readonly Evaluator[],
  onError: OnErrorCallback | undefined
): Promise<void> {
  try {
    await sink(payload)
  } catch (err) {
    for (const evaluator of evaluators) {
      await reportPipelineError(onError, err, payload.context, evaluator, 'sink')
    }
  }
}

async function reportPipelineError(
  onError: OnErrorCallback | undefined,
  err: unknown,
  ctx: EvaluatorContext,
  evaluator: Evaluator,
  location: OnErrorLocation
): Promise<void> {
  if (onError === undefined) return
  try {
    await onError(err, ctx, evaluator, location)
  } catch {
    // Match Python pydantic-evals: error handlers must not break sibling evaluators.
  }
}

function runWithParentSpanContext<R>(parentSpanRef: null | SpanReference, fn: () => R): R {
  if (parentSpanRef === null) return fn()
  const parentContext = TraceAPI.setSpanContext(ContextAPI.active(), {
    isRemote: false,
    spanId: parentSpanRef.spanId,
    traceFlags: TraceFlags.SAMPLED,
    traceId: parentSpanRef.traceId,
  })
  return ContextAPI.with(parentContext, fn)
}

function getContextArgNames(fn: (...args: unknown[]) => unknown, extractArgs: WithOnlineOptions['extractArgs']): null | readonly string[] {
  if (extractArgs === false) return null
  const names = Array.isArray(extractArgs) ? extractArgs : extractParamNames(fn)
  return names.length === 0 ? null : names
}

function buildEvaluatorInputs(args: readonly unknown[], argNames: null | readonly string[]): unknown {
  if (argNames === null) return args.length === 1 ? args[0] : [...args]
  const inputs: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i++) {
    inputs[argNames[i] ?? `arg${i.toString()}`] = args[i]
  }
  return inputs
}

function encodeReturnAttribute(output: unknown): boolean | number | string {
  if (typeof output === 'string' || typeof output === 'number' || typeof output === 'boolean') return output
  if (output === undefined || typeof output === 'function' || typeof output === 'symbol') return String(output)
  if (output instanceof Error) return `${output.name}: ${output.message}`
  try {
    return JSON.stringify(output)
  } catch {
    return '[unserializable]'
  }
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
