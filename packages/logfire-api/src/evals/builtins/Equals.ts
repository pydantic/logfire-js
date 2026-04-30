import type { EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/** True iff `output` is structurally equal to a fixed `value`. */
export class Equals extends Evaluator {
  static override evaluatorName = 'Equals'

  readonly value: unknown

  constructor(opts: { evaluation_name?: string; evaluationName?: string; value: unknown }) {
    super()
    this.value = opts.value
    this.evaluationName = opts.evaluationName ?? opts.evaluation_name
  }

  static jsonSchema(): Record<string, unknown> {
    return {
      additionalProperties: false,
      properties: {
        evaluation_name: { type: 'string' },
        value: {},
      },
      required: ['value'],
      type: 'object',
    }
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return deepEqual(ctx.output, this.value)
  }

  override toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { value: this.value }
    if (this.evaluationName !== undefined) {
      out['evaluation_name'] = this.evaluationName
    }
    return out
  }
}
registerEvaluator(Equals)

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== typeof b) {
    return false
  }
  if (a === null || b === null) {
    return false
  }
  if (typeof a !== 'object') {
    return false
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) {
      return false
    }
    if (a.length !== b.length) {
      return false
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false
      }
    }
    return true
  }
  if (Array.isArray(b)) {
    return false
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) {
    return false
  }
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false
    }
  }
  return true
}
