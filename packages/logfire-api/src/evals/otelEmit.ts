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

import type { EvaluationResultJson, EvaluatorFailureRecord } from './types'

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
  if (result.evaluator_version !== undefined) {
    attrs[GEN_AI_EVALUATOR_VERSION] = result.evaluator_version
  }
  if (result.reason !== null) {
    attrs[GEN_AI_EXPLANATION] = result.reason
  }

  encodeScoreAttrs(result.value, attrs)
  applyBaggage(attrs, opts.baggageAttrs)

  emit(buildBody(result.name, result.value), attrs, opts.parentSpanRef)
}

export function emitEvaluatorFailure(failure: EvaluatorFailureRecord, opts: EmitOptions): void {
  const errorType = failure.error_type || 'pydantic_evals.EvaluatorFailure'
  const errorMessage = failure.error_message || ''
  const attrs: Record<string, unknown> = {
    [ERROR_TYPE]: errorType,
    [GEN_AI_EVAL_NAME]: failure.name,
    [GEN_AI_EVAL_TARGET]: opts.target,
    [GEN_AI_EVALUATOR_SOURCE]: JSON.stringify(failure.source),
    [GEN_AI_EXPLANATION]: errorMessage,
  }
  if (failure.evaluator_version !== undefined) {
    attrs[GEN_AI_EVALUATOR_VERSION] = failure.evaluator_version
  }
  applyBaggage(attrs, opts.baggageAttrs)

  const body = errorMessage === '' ? `evaluation: ${failure.name} failed` : `evaluation: ${failure.name} failed: ${errorMessage}`
  emit(body, attrs, opts.parentSpanRef, SeverityNumber.WARN)
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
    formatted = pythonStringRepr(value)
  } else {
    formatted = formatPythonGeneralNumber(value)
  }
  return `evaluation: ${name}=${formatted}`
}

function emit(body: string, attrs: Record<string, unknown>, parentRef?: SpanReference, severityNumber?: SeverityNumber): void {
  const logger = getLogger()
  const ctxBase = ContextAPI.active()
  const ctx = parentRef === undefined ? ctxBase : TraceAPI.setSpanContext(ctxBase, { ...parentRef, traceFlags: 1 })
  ContextAPI.with(ctx, () => {
    logger.emit({
      attributes: attrs as Record<string, boolean | number | string>,
      body,
      eventName: EVAL_RESULT_EVENT_NAME,
      ...(severityNumber === undefined ? {} : { severityNumber }),
    })
  })
}

// Python's default `format(value, 'g')` precision.
const PYTHON_GENERAL_PRECISION = 6

/**
 * Reproduce CPython's `format(value, 'g')`.
 *
 * The rounding has to happen on the binary value rather than on any decimal string, because a
 * double is rarely the decimal it prints as: `0.1234555` is really 0.123455499..., which CPython
 * rounds down to `0.123455`. Formatting the shortest round-trip text instead rounds the literal
 * ties upward and gets `0.123456`. So the significand and exponent are pulled straight out of the
 * IEEE-754 bits and expanded to exact decimal digits with BigInt, then rounded half to even.
 */
function formatPythonGeneralNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'nan'
  }
  if (value === Infinity) {
    return 'inf'
  }
  if (value === -Infinity) {
    return '-inf'
  }
  if (value === 0) {
    return '0'
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e6) {
    return String(value)
  }

  const sign = value < 0 ? '-' : ''
  const { digits, pointExponent } = roundToSignificantDigits(exactDecimalDigits(Math.abs(value)))

  // `g` uses scientific notation once the exponent drops below -4 or reaches the precision, and
  // always writes at least two exponent digits.
  if (pointExponent < -4 || pointExponent >= PYTHON_GENERAL_PRECISION) {
    const mantissa = stripTrailingZeros(`${digits.slice(0, 1)}.${digits.slice(1)}`)
    const exponentSign = pointExponent < 0 ? '-' : '+'
    return `${sign}${mantissa}e${exponentSign}${Math.abs(pointExponent).toString().padStart(2, '0')}`
  }
  if (pointExponent < 0) {
    return `${sign}${stripTrailingZeros(`0.${'0'.repeat(-pointExponent - 1)}${digits}`)}`
  }
  const whole = digits.slice(0, pointExponent + 1)
  const fraction = digits.slice(pointExponent + 1)
  return `${sign}${stripTrailingZeros(fraction.length === 0 ? whole : `${whole}.${fraction}`)}`
}

/**
 * Every finite double is exactly `significand * 2 ** exponent`, which has a finite decimal
 * expansion. Returns all of its digits plus the base-10 exponent of the leading one.
 */
function exactDecimalDigits(magnitude: number): { digits: string; pointExponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, magnitude)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const biasedExponent = (high >>> 20) & 0x7ff
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
  // A zero biased exponent means subnormal, so there is no implicit leading one.
  const significand = biasedExponent === 0 ? fraction : fraction | (1n << 52n)
  const exponent = biasedExponent === 0 ? -1074 : biasedExponent - 1075

  if (exponent >= 0) {
    const digits = (significand << BigInt(exponent)).toString()
    return { digits, pointExponent: digits.length - 1 }
  }
  // Scaling by 5 ** -exponent turns the binary fraction into an exact decimal one.
  const digits = (significand * 5n ** BigInt(-exponent)).toString()
  return { digits, pointExponent: digits.length - 1 + exponent }
}

function roundToSignificantDigits(exact: { digits: string; pointExponent: number }): { digits: string; pointExponent: number } {
  let pointExponent = exact.pointExponent
  let kept = exact.digits.slice(0, PYTHON_GENERAL_PRECISION).padEnd(PYTHON_GENERAL_PRECISION, '0')
  const dropped = exact.digits.slice(PYTHON_GENERAL_PRECISION)
  if (dropped.length === 0) {
    return { digits: kept, pointExponent }
  }

  const first = dropped[0] ?? '0'
  const isExactHalf = first === '5' && /^0*$/u.test(dropped.slice(1))
  const lastKept = kept.charCodeAt(PYTHON_GENERAL_PRECISION - 1) - 48
  // Half to even on an exact tie, otherwise ordinary nearest.
  const roundUp = first > '5' || (isExactHalf ? lastKept % 2 === 1 : first === '5')
  if (!roundUp) {
    return { digits: kept, pointExponent }
  }

  const bumped = (BigInt(kept) + 1n).toString()
  if (bumped.length > PYTHON_GENERAL_PRECISION) {
    // 999999 carried into 1000000, so the leading digit moved up a place.
    kept = bumped.slice(0, PYTHON_GENERAL_PRECISION)
    pointExponent += 1
  } else {
    kept = bumped.padStart(PYTHON_GENERAL_PRECISION, '0')
  }
  return { digits: kept, pointExponent }
}

function stripTrailingZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/u, '') : text
}

function pythonStringRepr(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`
}

function applyBaggage(attrs: Record<string, unknown>, baggage: Record<string, unknown> | undefined): void {
  if (baggage === undefined) {
    return
  }
  // Standard semconv keys win over baggage on conflict.
  for (const [k, v] of Object.entries(baggage)) {
    if (!(k in attrs)) {
      attrs[k] = v
    }
  }
}
