import { evalSpan } from '../tracing'
import { EvaluatorContext } from './context'
import {
  EvaluationReason,
  evaluationReason,
  EvaluationResult,
  EvaluationScalar,
  Evaluator,
  EvaluatorFailure,
  EvaluatorOutput,
  isEvaluationReason,
} from './evaluator'

export async function runEvaluator(evaluator: Evaluator, ctx: EvaluatorContext): Promise<EvaluationResult[] | EvaluatorFailure> {
  const evaluatorName = evaluator.getDefaultEvaluationName()
  return await evalSpan('evaluator: {evaluator_name}', { evaluator_name: evaluatorName }, async () => runEvaluatorInner(evaluator, ctx))
}

async function runEvaluatorInner(evaluator: Evaluator, ctx: EvaluatorContext): Promise<EvaluationResult[] | EvaluatorFailure> {
  try {
    const raw = await evaluator.evaluateAsync(ctx)
    const mapping = convertToMapping(raw, evaluator.getDefaultEvaluationName())
    const details: EvaluationResult[] = []
    const source = evaluator.asSpec()
    for (const [name, value] of Object.entries(mapping)) {
      const reason: EvaluationReason = isEvaluationReason(value) ? value : evaluationReason(value)
      details.push({ name, reason: reason.reason ?? null, source, value: reason.value })
    }
    return details
  } catch (e) {
    const err = e as Error
    return {
      errorMessage: `${err.name}: ${err.message}`,
      errorStacktrace: err.stack ?? String(e),
      name: evaluator.getDefaultEvaluationName(),
      source: evaluator.asSpec(),
    }
  }
}

function convertToMapping(result: EvaluatorOutput, scalarName: string): Record<string, EvaluationReason | EvaluationScalar> {
  if (typeof result === 'boolean' || typeof result === 'number' || typeof result === 'string') {
    return { [scalarName]: result }
  }
  /* v8 ignore next 3 - reasons returned from evaluators are already handled in runEvaluator */
  if (isEvaluationReason(result)) {
    return { [scalarName]: result }
  }
  return result
}
