import type { EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/** True iff the task ran in at most `seconds` seconds. */
export class MaxDuration extends Evaluator {
  static evaluatorName = 'MaxDuration'

  readonly seconds: number

  constructor(opts: { seconds: number }) {
    super()
    this.seconds = opts.seconds
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return ctx.duration <= this.seconds
  }

  toJSON(): Record<string, unknown> {
    return { seconds: this.seconds }
  }
}
registerEvaluator(MaxDuration)
