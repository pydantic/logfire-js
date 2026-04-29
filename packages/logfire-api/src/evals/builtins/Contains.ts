import type { EvaluationReason, EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/**
 * True iff `output` contains `value`. Supports strings (substring), arrays
 * (element membership), and objects (key membership / value match).
 *
 * Mirrors pydantic-evals' `Contains` evaluator behaviour at
 * `evaluators/common.py:64–141`.
 */
export class Contains extends Evaluator {
  static evaluatorName = 'Contains'

  readonly asStrings: boolean
  readonly caseSensitive: boolean
  readonly value: unknown

  constructor(opts: { asStrings?: boolean; caseSensitive?: boolean; evaluationName?: string; value: unknown }) {
    super()
    this.value = opts.value
    this.caseSensitive = opts.caseSensitive ?? true
    this.asStrings = opts.asStrings ?? false
    if (opts.evaluationName !== undefined) this.evaluationName = opts.evaluationName
  }

  evaluate(ctx: EvaluatorContext): EvaluationReason {
    const result = this.check(ctx.output)
    return result
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { value: this.value }
    if (!this.caseSensitive) out.case_sensitive = false
    if (this.asStrings) out.as_strings = true
    if (this.evaluationName !== undefined) out.evaluation_name = this.evaluationName
    return out
  }

  private check(output: unknown): EvaluationReason {
    if (this.asStrings || (typeof output === 'string' && typeof this.value === 'string')) {
      const a = this.caseSensitive ? String(output) : String(output).toLowerCase()
      const b = this.caseSensitive ? String(this.value) : String(this.value).toLowerCase()
      const ok = a.includes(b)
      return { reason: ok ? 'output contains value' : 'output does not contain value', value: ok }
    }
    if (Array.isArray(output)) {
      for (const item of output) {
        if (deepEqualLoose(item, this.value, this.caseSensitive)) {
          return { reason: 'value found in output array', value: true }
        }
      }
      return { reason: 'value not found in output array', value: false }
    }
    if (output !== null && typeof output === 'object') {
      const obj = output as Record<string, unknown>
      // Either a matching key OR a matching value qualifies as "contains"
      for (const [k, v] of Object.entries(obj)) {
        if (deepEqualLoose(k, this.value, this.caseSensitive)) return { reason: 'key matches value', value: true }
        if (deepEqualLoose(v, this.value, this.caseSensitive)) return { reason: 'object value matches', value: true }
      }
      return { reason: 'value not found in object', value: false }
    }
    return { reason: 'output is not iterable', value: false }
  }
}
registerEvaluator(Contains)

function deepEqualLoose(a: unknown, b: unknown, caseSensitive: boolean): boolean {
  if (typeof a === 'string' && typeof b === 'string' && !caseSensitive) {
    return a.toLowerCase() === b.toLowerCase()
  }
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}
