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
  return value
    .toPrecision(6)
    .replace(/(\.\d*?)0+(e|$)/u, '$1$2')
    .replace(/\.e/u, 'e')
    .replace(/e([+-])(\d)$/u, 'e$10$2')
}

// Python's `str.isprintable()` treats the Unicode "Other" and "Separator" categories as
// non-printable, except the ASCII space.
const PYTHON_NON_PRINTABLE = /[\p{C}\p{Z}]/u
const PYTHON_SHORT_ESCAPES: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' }

function pythonStringRepr(value: string): string {
  // CPython prefers single quotes, switching to double quotes only when the value contains a
  // single quote and no double quote, and escapes just the quote character it ends up using.
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let escaped = ''
  for (const char of value) {
    if (char === '\\' || char === quote) {
      escaped += `\\${char}`
      continue
    }
    const shortEscape = PYTHON_SHORT_ESCAPES[char]
    if (shortEscape !== undefined) {
      escaped += shortEscape
      continue
    }
    if (char !== ' ' && PYTHON_NON_PRINTABLE.test(char)) {
      const codePoint = char.codePointAt(0) ?? 0
      if (codePoint < 0x100) {
        escaped += `\\x${codePoint.toString(16).padStart(2, '0')}`
      } else if (codePoint < 0x10000) {
        escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`
      } else {
        escaped += `\\U${codePoint.toString(16).padStart(8, '0')}`
      }
      continue
    }
    escaped += char
  }
  return `${quote}${escaped}${quote}`
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
