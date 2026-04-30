import type { EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'
import { spanQueryToSnakeCase } from '../spanTree'
import type { SpanQuery } from '../spanTree'

/** True iff a span matching `query` was emitted under the user's task. */
export class HasMatchingSpan extends Evaluator {
  static override evaluatorName = 'HasMatchingSpan'

  readonly query: SpanQuery

  constructor(opts: { evaluation_name?: string; evaluationName?: string; query: SpanQuery }) {
    super()
    this.query = opts.query
    this.evaluationName = opts.evaluationName ?? opts.evaluation_name
  }

  static jsonSchema(): Record<string, unknown> {
    return {
      additionalProperties: false,
      properties: {
        evaluation_name: { type: 'string' },
        query: { type: 'object' },
      },
      required: ['query'],
      type: 'object',
    }
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return ctx.spanTree.any(this.query)
  }

  override toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { query: spanQueryToSnakeCase(this.query) }
    if (this.evaluationName !== undefined) {
      out['evaluation_name'] = this.evaluationName
    }
    return out
  }
}
registerEvaluator(HasMatchingSpan)
