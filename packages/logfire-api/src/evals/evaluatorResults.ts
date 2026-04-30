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

export function buildEvaluationResultJson(
  name: string,
  value: boolean | EvaluationReason | number | string,
  source: EvaluatorSpec,
  evaluatorVersion?: string
): EvaluationResultJson {
  const reason = isEvaluationReason(value) ? (value.reason ?? null) : null
  const scalar = isEvaluationReason(value) ? value.value : value
  const out: EvaluationResultJson = {
    name,
    reason,
    source,
    value: scalar,
  }
  if (evaluatorVersion !== undefined) out.evaluator_version = evaluatorVersion
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
  if (isErr && err.stack !== undefined) out.error_stacktrace = err.stack
  if (evaluatorVersion !== undefined) out.evaluator_version = evaluatorVersion
  return out
}

export function isEvaluationReason(value: unknown): value is EvaluationReason {
  return typeof value === 'object' && value !== null && 'value' in value && !Array.isArray(value)
}

function isEvaluationScalar(value: EvaluatorOutput): value is boolean | EvaluationReason | number | string {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' || isEvaluationReason(value)
}
