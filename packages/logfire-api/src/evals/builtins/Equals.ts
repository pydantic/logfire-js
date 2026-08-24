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
    const evaluationName = opts.evaluationName ?? opts.evaluation_name
    if (evaluationName !== undefined) {
      this.evaluationName = evaluationName
    }
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
  // Everything below compares own enumerable keys, and a Date, RegExp, Set or Map keeps its
  // contents in internal slots instead. Any two of them have no keys at all, so they compared
  // equal to each other, a Date to a Map included.
  const tag = Object.prototype.toString.call(a)
  if (tag !== Object.prototype.toString.call(b)) {
    return false
  }
  if (tag === '[object Date]') {
    return (a as Date).getTime() === (b as Date).getTime()
  }
  if (tag === '[object RegExp]') {
    return (a as RegExp).source === (b as RegExp).source && (a as RegExp).flags === (b as RegExp).flags
  }
  if (tag === '[object Set]') {
    return setsEqual(a as Set<unknown>, b as Set<unknown>)
  }
  if (tag === '[object Map]') {
    return mapsEqual(a as Map<unknown, unknown>, b as Map<unknown, unknown>)
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

/** Members are matched with `has`, so membership is SameValueZero, the semantics a Set caller expects. */
function setsEqual(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false
    }
  }
  return true
}

/** Keys are matched with `has` for the same reason; values still compare structurally. */
function mapsEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [key, value] of a) {
    if (!b.has(key) || !deepEqual(value, b.get(key))) {
      return false
    }
  }
  return true
}
