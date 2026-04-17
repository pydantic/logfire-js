import { EvaluatorContext } from './context'
import { EvaluatorSpec } from './spec'

export type EvaluationScalar = boolean | number | string

export interface EvaluationReason<T extends EvaluationScalar = EvaluationScalar> {
  reason?: null | string
  value: T
}

export function evaluationReason<T extends EvaluationScalar>(value: T, reason?: null | string): EvaluationReason<T> {
  return { reason: reason ?? null, value }
}

export function isEvaluationReason(value: unknown): value is EvaluationReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    'value' in value &&
    (typeof (value as { value: unknown }).value === 'boolean' ||
      typeof (value as { value: unknown }).value === 'number' ||
      typeof (value as { value: unknown }).value === 'string')
  )
}

export type EvaluatorOutput = EvaluationReason | EvaluationScalar | Record<string, EvaluationReason | EvaluationScalar>

export interface EvaluationResult<T extends EvaluationScalar = EvaluationScalar> {
  name: string
  reason: null | string
  source: EvaluatorSpec
  value: T
}

export function downcastEvaluationResult<T extends EvaluationScalar>(
  result: EvaluationResult,
  ...types: ('boolean' | 'number' | 'string')[]
): EvaluationResult<T> | null {
  for (const t of types) {
    if (t === 'boolean' && typeof result.value === 'boolean') {
      return result as EvaluationResult<T>
    }
    if (t === 'number' && typeof result.value === 'number' && typeof result.value !== 'boolean') {
      return result as EvaluationResult<T>
    }
    if (t === 'string' && typeof result.value === 'string') {
      return result as EvaluationResult<T>
    }
  }
  return null
}

export interface EvaluatorFailure {
  errorMessage: string
  errorStacktrace: string
  name: string
  source: EvaluatorSpec
}

export abstract class Evaluator<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  evaluationName?: string

  asSpec(): EvaluatorSpec {
    const args = this.buildSerializationArguments()
    const keys = Object.keys(args)
    let argumentsField: EvaluatorSpec['arguments']
    if (keys.length === 0) {
      argumentsField = null
    } else if (keys.length === 1) {
      // Positional tuple form if the key is the first declared argument
      argumentsField = args
    } else {
      argumentsField = args
    }
    return { arguments: argumentsField, name: this.getSerializationName() }
  }

  buildSerializationArguments(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const self = this as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(self)) {
      if (v === undefined) continue
      out[k] = v
    }
    return out
  }

  abstract evaluate(ctx: EvaluatorContext<InputsT, OutputT, MetadataT>): EvaluatorOutput | Promise<EvaluatorOutput>

  async evaluateAsync(ctx: EvaluatorContext<InputsT, OutputT, MetadataT>): Promise<EvaluatorOutput> {
    return await Promise.resolve(this.evaluate(ctx))
  }

  getDefaultEvaluationName(): string {
    if (typeof this.evaluationName === 'string') return this.evaluationName
    return this.getSerializationName()
  }

  getSerializationName(): string {
    const ctor = (this as unknown as { constructor: { name: string } }).constructor
    return ctor.name
  }
}
