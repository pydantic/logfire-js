import type { SpanQuery } from '../spanTree'
import type { EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/** True iff a span matching `query` was emitted under the user's task. */
export class HasMatchingSpan extends Evaluator {
  static evaluatorName = 'HasMatchingSpan'

  readonly query: SpanQuery

  constructor(opts: { evaluationName?: string; query: SpanQuery }) {
    super()
    this.query = opts.query
    if (opts.evaluationName !== undefined) this.evaluationName = opts.evaluationName
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return ctx.spanTree.any(this.query)
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { query: this.query }
    if (this.evaluationName !== undefined) out.evaluation_name = this.evaluationName
    return out
  }
}
registerEvaluator(HasMatchingSpan)
