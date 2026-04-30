import type { EvaluationReason, EvaluatorContext } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'
import { deepEqual } from './Equals'

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

  constructor(opts: {
    as_strings?: boolean
    asStrings?: boolean
    case_sensitive?: boolean
    caseSensitive?: boolean
    evaluation_name?: string
    evaluationName?: string
    value: unknown
  }) {
    super()
    this.value = opts.value
    this.caseSensitive = opts.caseSensitive ?? opts.case_sensitive ?? true
    this.asStrings = opts.asStrings ?? opts.as_strings ?? false
    this.evaluationName = opts.evaluationName ?? opts.evaluation_name
  }

  static jsonSchema(): Record<string, unknown> {
    return {
      additionalProperties: false,
      properties: {
        as_strings: { default: false, type: 'boolean' },
        case_sensitive: { default: true, type: 'boolean' },
        evaluation_name: { type: 'string' },
        value: {},
      },
      required: ['value'],
      type: 'object',
    }
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
      if (ok) return { value: true }
      return { reason: `Output string ${truncatedRepr(a, 100)} does not contain expected string ${truncatedRepr(b, 100)}`, value: false }
    }
    if (Array.isArray(output)) {
      for (const item of output) {
        if (deepEqual(item, this.value)) {
          return { value: true }
        }
      }
      return { reason: `Output ${truncatedRepr(output, 200)} does not contain provided value`, value: false }
    }
    if (output !== null && typeof output === 'object') {
      const obj = output as Record<string, unknown>
      if (isPlainRecord(this.value)) {
        for (const [key, expected] of Object.entries(this.value)) {
          if (!(key in obj)) {
            return { reason: `Output does not contain expected key ${truncatedRepr(key, 30)}`, value: false }
          }
          if (!deepEqual(obj[key], expected)) {
            return {
              reason: `Output has different value for key ${truncatedRepr(key, 30)}: ${truncatedRepr(obj[key], 100)} != ${truncatedRepr(expected, 100)}`,
              value: false,
            }
          }
        }
        return { value: true }
      }
      const key = String(this.value)
      return key in obj
        ? { value: true }
        : { reason: `Output ${truncatedRepr(obj, 200)} does not contain provided value as a key`, value: false }
    }
    return { reason: 'Containment check failed: output is not iterable', value: false }
  }
}
registerEvaluator(Contains)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function truncatedRepr(value: unknown, maxLength: number): string {
  let repr: string
  if (typeof value === 'string') {
    repr = JSON.stringify(value)
  } else {
    try {
      repr = JSON.stringify(value)
    } catch {
      repr = String(value)
    }
  }
  if (repr.length <= maxLength) return repr
  return `${repr.slice(0, Math.floor(maxLength / 2))}...${repr.slice(-Math.floor(maxLength / 2))}`
}
