/**
 * Run evaluators against a single case and post-process their outputs into the
 * canonical `assertions` / `scores` / `labels` wire shape that the Logfire UI
 * strict-parses.
 */

import pRetry from 'p-retry'

import type { Evaluator } from './Evaluator'
import type { EvaluationResultJson, EvaluatorContext, EvaluatorFailureRecord, EvaluatorOutput, RetryConfig } from './types'

import { ATTR_EVALUATOR_NAME, SPAN_MSG_TEMPLATE_EVALUATOR, SPAN_NAME_EVALUATOR_LITERAL } from './constants'
import { buildEvaluatorFailureRecord, evaluationResultsFromOutput } from './evaluatorResults'
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
      for (const item of evaluationResultsFromOutput(raw, evaluatorName, spec, evaluator.evaluatorVersion)) {
        place(result, item)
      }
    } catch (err) {
      result.failures.push(buildEvaluatorFailureRecord(err, evaluatorName, spec, evaluator.evaluatorVersion))
    }
  }
  return result
}

function place(out: RunEvaluatorsResult, result: EvaluationResultJson): void {
  if (typeof result.value === 'boolean') {
    out.assertions[result.name] = result
  } else if (typeof result.value === 'number') {
    out.scores[result.name] = result
  } else {
    out.labels[result.name] = result
  }
}
