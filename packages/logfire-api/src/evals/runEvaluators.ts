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

  const runs = await Promise.all(
    evaluators.map(async (evaluator) => {
      const evaluatorName = evaluator.getResultName()
      const spec = evaluator.getSpec()
      try {
        const runOnce = async (): Promise<EvaluatorOutput> =>
          evalsSpan(
            SPAN_MSG_TEMPLATE_EVALUATOR,
            {
              attributes: { [ATTR_EVALUATOR_NAME]: evaluatorName },
              spanName: SPAN_NAME_EVALUATOR_LITERAL,
            },
            async () => evaluator.evaluate(ctx)
          )
        const raw = retryEvaluators === undefined ? await runOnce() : await pRetry(runOnce, retryEvaluators)
        return {
          failures: [],
          results: evaluationResultsFromOutput(raw, evaluatorName, spec, evaluator.evaluatorVersion),
        }
      } catch (err) {
        return {
          failures: [buildEvaluatorFailureRecord(err, evaluatorName, spec, evaluator.evaluatorVersion)],
          results: [],
        }
      }
    })
  )

  for (const run of runs) {
    result.failures.push(...run.failures)
    for (const item of run.results) {
      place(result, item)
    }
  }
  return result
}

function place(out: RunEvaluatorsResult, result: EvaluationResultJson): void {
  if (typeof result.value === 'boolean') {
    const name = nextResultName(out.assertions, result.name)
    out.assertions[name] = { ...result, name }
  } else if (typeof result.value === 'number') {
    const name = nextResultName(out.scores, result.name)
    out.scores[name] = { ...result, name }
  } else {
    const name = nextResultName(out.labels, result.name)
    out.labels[name] = { ...result, name }
  }
}

function nextResultName(existing: Record<string, EvaluationResultJson>, baseName: string): string {
  if (existing[baseName] === undefined) {
    return baseName
  }
  let i = 2
  while (existing[`${baseName}_${i.toString()}`] !== undefined) {
    i++
  }
  return `${baseName}_${i.toString()}`
}
