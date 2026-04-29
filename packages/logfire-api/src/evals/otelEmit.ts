/**
 * Online-eval OTel log event emission.
 *
 * Mirrors pydantic-evals' `_otel_emit.py` exactly. Each `EvaluationResult` /
 * `EvaluatorFailure` produced by an online evaluator becomes one OTel log
 * record named `gen_ai.evaluation.result`, parented (via a `NonRecordingSpan`
 * built from the call span's context) to the wrapped function's span.
 */

import type { Span } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'

import { context as ContextAPI, trace as TraceAPI } from '@opentelemetry/api'
import { logs as LogsAPI, SeverityNumber } from '@opentelemetry/api-logs'

import type { EvaluationReason, EvaluationResultJson, EvaluatorFailureRecord, EvaluatorSpec } from './types'

import {
  ERROR_TYPE,
  EVAL_RESULT_EVENT_NAME,
  EVALS_OTEL_SCOPE,
  GEN_AI_EVAL_NAME,
  GEN_AI_EVAL_TARGET,
  GEN_AI_EVALUATOR_SOURCE,
  GEN_AI_EVALUATOR_VERSION,
  GEN_AI_EXPLANATION,
  GEN_AI_SCORE_LABEL,
  GEN_AI_SCORE_VALUE,
} from './constants'

function getLogger(): Logger {
  return LogsAPI.getLogger(EVALS_OTEL_SCOPE)
}

export interface SpanReference {
  spanId: string
  traceId: string
}

export function spanReferenceFromSpan(span: Span): SpanReference {
  const ctx = span.spanContext()
  return { spanId: ctx.spanId, traceId: ctx.traceId }
}

interface EmitOptions {
  baggageAttrs?: Record<string, unknown>
  parentSpanRef?: SpanReference
  target: string
}

export function emitEvaluationResult(result: EvaluationResultJson, opts: EmitOptions): void {
  const attrs: Record<string, unknown> = {
    [GEN_AI_EVAL_NAME]: result.name,
    [GEN_AI_EVAL_TARGET]: opts.target,
    [GEN_AI_EVALUATOR_SOURCE]: JSON.stringify(result.source),
  }
  if (result.evaluator_version !== undefined) attrs[GEN_AI_EVALUATOR_VERSION] = result.evaluator_version
  if (result.reason !== null) attrs[GEN_AI_EXPLANATION] = result.reason

  encodeScoreAttrs(result.value, attrs)
  applyBaggage(attrs, opts.baggageAttrs)

  emit(buildBody(result.name, result.value), attrs, SeverityNumber.INFO, opts.parentSpanRef)
}

export function emitEvaluatorFailure(failure: EvaluatorFailureRecord, opts: EmitOptions): void {
  const attrs: Record<string, unknown> = {
    [ERROR_TYPE]: failure.error_type,
    [GEN_AI_EVAL_NAME]: failure.name,
    [GEN_AI_EVAL_TARGET]: opts.target,
    [GEN_AI_EVALUATOR_SOURCE]: JSON.stringify(failure.source),
    [GEN_AI_EXPLANATION]: failure.error_message,
  }
  if (failure.evaluator_version !== undefined) attrs[GEN_AI_EVALUATOR_VERSION] = failure.evaluator_version
  applyBaggage(attrs, opts.baggageAttrs)

  emit(`evaluation: ${failure.name} failed: ${failure.error_message}`, attrs, SeverityNumber.WARN, opts.parentSpanRef)
}

function encodeScoreAttrs(value: boolean | number | string, attrs: Record<string, unknown>): void {
  if (typeof value === 'boolean') {
    attrs[GEN_AI_SCORE_VALUE] = value ? 1.0 : 0.0
    attrs[GEN_AI_SCORE_LABEL] = value ? 'pass' : 'fail'
  } else if (typeof value === 'number') {
    attrs[GEN_AI_SCORE_VALUE] = value
  } else {
    attrs[GEN_AI_SCORE_LABEL] = value
  }
}

function buildBody(name: string, value: boolean | number | string): string {
  let formatted: string
  if (typeof value === 'boolean') {
    formatted = value ? 'True' : 'False' // matches Python repr
  } else if (typeof value === 'string') {
    formatted = JSON.stringify(value)
  } else {
    // number — JS String() gives a reasonable shortest-form rendering
    formatted = String(value)
  }
  return `evaluation: ${name}=${formatted}`
}

function emit(body: string, attrs: Record<string, unknown>, severityNumber: SeverityNumber, parentRef?: SpanReference): void {
  const logger = getLogger()
  const ctxBase = ContextAPI.active()
  const ctx = parentRef === undefined ? ctxBase : TraceAPI.setSpanContext(ctxBase, { ...parentRef, traceFlags: 1 })
  ContextAPI.with(ctx, () => {
    logger.emit({
      attributes: attrs as Record<string, boolean | number | string>,
      body,
      eventName: EVAL_RESULT_EVENT_NAME,
      severityNumber,
    })
  })
}

function applyBaggage(attrs: Record<string, unknown>, baggage: Record<string, unknown> | undefined): void {
  if (baggage === undefined) return
  // Standard semconv keys win over baggage on conflict.
  for (const [k, v] of Object.entries(baggage)) {
    if (!(k in attrs)) attrs[k] = v
  }
}

/**
 * Combine `EvaluationReason` / scalar evaluator output into a single
 * `EvaluationResultJson` ready for emission. Used by the online wrapper to
 * normalize whatever the evaluator returned.
 */
export function buildEvaluationResultJson(
  defaultName: string,
  value: boolean | EvaluationReason | number | string,
  source: EvaluatorSpec,
  evaluatorVersion?: string
): EvaluationResultJson {
  const reason = isReason(value) ? (value.reason ?? null) : null
  const scalar = isReason(value) ? value.value : value
  const out: EvaluationResultJson = {
    name: defaultName,
    reason,
    source,
    value: scalar,
  }
  if (evaluatorVersion !== undefined) out.evaluator_version = evaluatorVersion
  return out
}

function isReason(v: unknown): v is EvaluationReason {
  return typeof v === 'object' && v !== null && 'value' in v && !Array.isArray(v)
}
