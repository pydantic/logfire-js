import type { EvaluationReason, EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/**
 * True iff the runtime constructor name (or one of its prototype-chain ancestors)
 * matches `typeName`. This is the closest TS analogue of Python's MRO walk on
 * class names.
 */
export class IsInstance extends Evaluator {
  static evaluatorName = 'IsInstance'

  readonly typeName: string

  constructor(opts: { evaluationName?: string; typeName: string }) {
    super()
    this.typeName = opts.typeName
    if (opts.evaluationName !== undefined) this.evaluationName = opts.evaluationName
  }

  evaluate(ctx: EvaluatorContext): EvaluationReason {
    const out = ctx.output
    if (out === null || out === undefined) {
      return { reason: `output is ${out === null ? 'null' : 'undefined'}`, value: false }
    }
    let proto: unknown = Object.getPrototypeOf(out)
    while (proto !== null && proto !== undefined) {
      const ctor = (proto as { constructor?: { name?: string } }).constructor
      if (ctor?.name === this.typeName) {
        return { reason: `output is instance of ${this.typeName}`, value: true }
      }
      proto = Object.getPrototypeOf(proto)
    }
    // Primitive fallback — `typeof` covers the no-prototype case (e.g. raw strings).
    const lowered = this.typeName.toLowerCase()
    const primitives = ['string', 'number', 'boolean', 'bigint', 'symbol', 'undefined', 'object', 'function'] as const
    type PrimitiveTypeName = (typeof primitives)[number]
    if ((primitives as readonly string[]).includes(lowered)) {
      // eslint-disable-next-line valid-typeof
      if (typeof out === (lowered as PrimitiveTypeName)) {
        return { reason: `output typeof matches ${this.typeName}`, value: true }
      }
    }
    return { reason: `output is not instance of ${this.typeName}`, value: false }
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { type_name: this.typeName }
    if (this.evaluationName !== undefined) out.evaluation_name = this.evaluationName
    return out
  }
}
registerEvaluator(IsInstance)
