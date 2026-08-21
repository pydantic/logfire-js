import type { EvaluationReason, EvaluationResultJson, EvaluatorFailureRecord, EvaluatorOutput, EvaluatorSpec } from './types'

export function evaluationResultsFromOutput(
  raw: EvaluatorOutput,
  defaultName: string,
  source: EvaluatorSpec,
  evaluatorVersion?: string
): EvaluationResultJson[] {
  if (isEvaluationScalar(raw)) {
    return [buildEvaluationResultJson(defaultName, raw, source, evaluatorVersion)]
  }
  return Object.entries(raw).map(([name, value]) => buildEvaluationResultJson(name, value, source, evaluatorVersion))
}

/**
 * A result map and an `EvaluationReason` are both plain objects, so they can only be
 * told apart by their shape. `EvaluationReason` declares exactly a scalar `value` and
 * an optional string `reason`, so anything else is a result map. Key names alone are
 * not enough: `{ value: 0.8, reason: 0.9 }` is a legal map of scores.
 */
function isSoleEvaluationReason(value: unknown): value is EvaluationReason {
  if (!isEvaluationReason(value)) {
    return false
  }
  return Object.entries(value).every(
    ([key, entry]) => (key === 'value' && isScalar(entry)) || (key === 'reason' && (typeof entry === 'string' || entry === undefined))
  )
}

function isScalar(value: unknown): value is boolean | number | string {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
}

export function buildEvaluationResultJson(
  name: string,
  value: boolean | EvaluationReason | number | string,
  source: EvaluatorSpec,
  evaluatorVersion?: string
): EvaluationResultJson {
  const reason = isEvaluationReason(value) ? (value.reason ?? null) : null
  const scalar = isEvaluationReason(value) ? value.value : value
  if (typeof scalar === 'number' && !Number.isFinite(scalar)) {
    // `EvaluationScalar` is `bool | int | Annotated[float, Field(allow_inf_nan=False)] | str`, so
    // pydantic-evals rejects these and reports an evaluator failure. Both callers here run inside
    // a try that does the same, and a non-finite score would otherwise make every aggregate over
    // that key NaN.
    throw new Error(`Evaluator returned a non-finite value for ${name}: ${String(scalar)}`)
  }
  const out: EvaluationResultJson = {
    name,
    reason,
    source,
    value: scalar,
  }
  if (evaluatorVersion !== undefined) {
    out.evaluator_version = evaluatorVersion
  }
  return out
}

export function buildEvaluatorFailureRecord(
  err: unknown,
  name: string,
  source: EvaluatorSpec,
  evaluatorVersion?: string
): EvaluatorFailureRecord {
  const isErr = err instanceof Error
  const out: EvaluatorFailureRecord = {
    error_message: isErr ? err.message : String(err),
    error_type: isErr ? err.constructor.name : 'Error',
    name,
    source,
  }
  if (isErr && err.stack !== undefined) {
    out.error_stacktrace = err.stack
  }
  if (evaluatorVersion !== undefined) {
    out.evaluator_version = evaluatorVersion
  }
  return out
}

export function isEvaluationReason(value: unknown): value is EvaluationReason {
  return typeof value === 'object' && value !== null && 'value' in value && !Array.isArray(value)
}

function isEvaluationScalar(value: EvaluatorOutput): value is boolean | EvaluationReason | number | string {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' || isSoleEvaluationReason(value)
}
