export interface EvaluatorSpec {
  arguments?: [unknown] | null | Record<string, unknown>
  name: string
}

export type EvaluatorSerializedForm = Record<string, [unknown] | Record<string, unknown>> | string

export function parseEvaluatorSpec(value: EvaluatorSerializedForm): EvaluatorSpec {
  if (typeof value === 'string') {
    return { arguments: null, name: value }
  }
  const entries = Object.entries(value)
  if (entries.length !== 1) {
    throw new Error('Evaluator spec object must have exactly one key (the evaluator name).')
  }
  const [name, args] = entries[0]!
  if (Array.isArray(args)) {
    if (args.length !== 1) {
      throw new Error(`Evaluator spec for ${name}: positional form must be a single-element array.`)
    }
    return { arguments: [args[0]], name }
  }
  if (args !== null && typeof args === 'object') {
    return { arguments: args, name }
  }
  // Scalar - treat as single positional arg
  return { arguments: [args], name }
}

export function serializeEvaluatorSpec(spec: EvaluatorSpec): EvaluatorSerializedForm {
  if (spec.arguments === null || spec.arguments === undefined) {
    return spec.name
  }
  return { [spec.name]: spec.arguments }
}
