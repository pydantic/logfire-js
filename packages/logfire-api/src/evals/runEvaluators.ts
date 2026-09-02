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
  // Result names come from evaluators, so they can collide with `Object.prototype` members like
  // `toString` or `__proto__`. Accumulate into Maps, where any key is just a key, and convert at
  // the end with `Object.fromEntries`, which defines own properties.
  const buckets = {
    assertions: new Map<string, EvaluationResultJson>(),
    labels: new Map<string, EvaluationResultJson>(),
    scores: new Map<string, EvaluationResultJson>(),
  }
  const failures: EvaluatorFailureRecord[] = []

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
    failures.push(...run.failures)
    for (const item of run.results) {
      place(buckets, item)
    }
  }
  return {
    assertions: Object.fromEntries(buckets.assertions),
    failures,
    labels: Object.fromEntries(buckets.labels),
    scores: Object.fromEntries(buckets.scores),
  }
}

type Buckets = Record<'assertions' | 'labels' | 'scores', Map<string, EvaluationResultJson>>

function place(out: Buckets, result: EvaluationResultJson): void {
  const bucket = typeof result.value === 'boolean' ? out.assertions : typeof result.value === 'number' ? out.scores : out.labels
  const name = nextResultName(bucket, result.name)
  bucket.set(name, { ...result, name })
}

function nextResultName(existing: ReadonlyMap<string, EvaluationResultJson>, baseName: string): string {
  if (!existing.has(baseName)) {
    return baseName
  }
  let i = 2
  while (existing.has(`${baseName}_${i.toString()}`)) {
    i++
  }
  return `${baseName}_${i.toString()}`
}
