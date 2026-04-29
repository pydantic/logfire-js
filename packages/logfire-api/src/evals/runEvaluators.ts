/**
 * Run evaluators against a single case and post-process their outputs into the
 * canonical `assertions` / `scores` / `labels` wire shape that the Logfire UI
 * strict-parses.
 */

import pRetry from 'p-retry'

import type { Evaluator } from './Evaluator'
import type {
  EvaluationReason,
  EvaluationResultJson,
  EvaluatorContext,
  EvaluatorFailureRecord,
  EvaluatorOutput,
  EvaluatorSpec,
  RetryConfig,
} from './types'

import { ATTR_EVALUATOR_NAME, SPAN_MSG_TEMPLATE_EVALUATOR, SPAN_NAME_EVALUATOR_LITERAL } from './constants'
import { evalsSpan } from './internal'

export interface RunEvaluatorsResult {
  assertions: Record<string, EvaluationResultJson>
  failures: EvaluatorFailureRecord[]
  labels: Record<string, EvaluationResultJson>
  scores: Record<string, EvaluationResultJson>
}

export async function runEvaluators(
  evaluators: readonly Evaluator[],
  ctx: EvaluatorContext,
  retryEvaluators?: RetryConfig
): Promise<RunEvaluatorsResult> {
  const result: RunEvaluatorsResult = { assertions: {}, failures: [], labels: {}, scores: {} }

  for (const evaluator of evaluators) {
    const evaluatorName = evaluator.getResultName()
    const spec = evaluator.getSpec()
    try {
      const runOnce = (): Promise<EvaluatorOutput> =>
        evalsSpan(
          SPAN_MSG_TEMPLATE_EVALUATOR,
          {
            attributes: { [ATTR_EVALUATOR_NAME]: evaluatorName },
            spanName: SPAN_NAME_EVALUATOR_LITERAL,
          },
          async () => evaluator.evaluate(ctx)
        )
      const raw = retryEvaluators === undefined ? await runOnce() : await pRetry(runOnce, retryEvaluators)
      mergeEvaluatorOutput(result, raw, evaluatorName, spec, evaluator.evaluatorVersion)
    } catch (err) {
      result.failures.push(buildFailureRecord(err, evaluatorName, spec, evaluator.evaluatorVersion))
    }
  }
  return result
}

function mergeEvaluatorOutput(
  out: RunEvaluatorsResult,
  raw: EvaluatorOutput,
  defaultName: string,
  spec: EvaluatorSpec,
  evaluatorVersion?: string
): void {
  if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string' || isReason(raw)) {
    place(out, defaultName, raw, spec, evaluatorVersion)
    return
  }
  for (const [name, value] of Object.entries(raw)) {
    place(out, name, value, spec, evaluatorVersion)
  }
}

function place(
  out: RunEvaluatorsResult,
  name: string,
  value: boolean | EvaluationReason | number | string,
  spec: EvaluatorSpec,
  evaluatorVersion?: string
): void {
  const reason = isReason(value) ? (value.reason ?? null) : null
  const scalar = isReason(value) ? value.value : value
  const json: EvaluationResultJson = {
    name,
    reason,
    source: spec,
    value: scalar,
  }
  if (evaluatorVersion !== undefined) json.evaluator_version = evaluatorVersion
  if (typeof scalar === 'boolean') {
    out.assertions[name] = json
  } else if (typeof scalar === 'number') {
    out.scores[name] = json
  } else {
    out.labels[name] = json
  }
}

function isReason(v: unknown): v is EvaluationReason {
  return typeof v === 'object' && v !== null && 'value' in v && !Array.isArray(v)
}

function buildFailureRecord(err: unknown, name: string, spec: EvaluatorSpec, evaluatorVersion?: string): EvaluatorFailureRecord {
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
