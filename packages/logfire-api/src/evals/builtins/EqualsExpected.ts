import type { EvaluatorContext, EvaluatorOutput } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'
import { deepEqual } from './Equals'

/**
 * True iff `output === expectedOutput`. If the case has no expected output,
 * returns an empty mapping (no result emitted) — same as Python pydantic-evals.
 */
export class EqualsExpected extends Evaluator {
  static evaluatorName = 'EqualsExpected'

  constructor(opts: { evaluationName?: string } = {}) {
    super()
    if (opts.evaluationName !== undefined) this.evaluationName = opts.evaluationName
  }

  evaluate(ctx: EvaluatorContext): EvaluatorOutput {
    if (ctx.expectedOutput === undefined) return {}
    return deepEqual(ctx.output, ctx.expectedOutput)
  }

  toJSON(): null | Record<string, unknown> {
    if (this.evaluationName === undefined) return null
    return { evaluation_name: this.evaluationName }
  }
}
registerEvaluator(EqualsExpected)
