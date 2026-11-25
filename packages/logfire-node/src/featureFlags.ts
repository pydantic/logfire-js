import { startSpan, span } from 'logfire'
import { getVariableProvider, registerFeatureFlag, shouldInstrumentFeatureFlags } from 'logfire/vars'
import type { FeatureFlagVariable, JsonSchema, ResolvedVariable } from 'logfire/vars'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

import { getFlagEvaluationInputs, withFlagOverride } from './featureFlagContext'
import type { FeatureContext } from './featureFlagContext'

export { withFeatureContext } from './featureFlagContext'
export type { FeatureContext } from './featureFlagContext'

export interface FlagDetails<T> {
  flagKey: string
  value: T
  reason: 'context_override' | 'default' | 'error' | 'split' | 'stale' | 'static' | 'targeting_match'
  variant?: string
  errorCode?: 'flag_not_found' | 'general' | 'provider_not_ready' | 'targeting_key_missing' | 'type_mismatch'
  valueVersion?: number
}

export interface Flag<T, Input = T> {
  readonly name: string
  readonly description: string | undefined
  value(options?: FeatureContext): Promise<T>
  details(options?: FeatureContext): Promise<FlagDetails<T>>
  override<R>(value: Input, callback: () => R): R
}

type Primitive = boolean | number | string

interface FlagOptions<Input> {
  default: Input
  description?: string
}

interface TypedFlagOptions<Input, Output> extends FlagOptions<Input> {
  schema: StandardSchemaV1<Input, Output> & {
    '~standard': Partial<Pick<StandardJSONSchemaV1<Input, Output>['~standard'], 'jsonSchema'>>
  }
}

export function defineFlag(name: string, options: FlagOptions<boolean>): Flag<boolean>
export function defineFlag(name: string, options: FlagOptions<number>): Flag<number>
export function defineFlag(name: string, options: FlagOptions<string>): Flag<string>
export function defineFlag<Input, Output>(name: string, options: TypedFlagOptions<Input, Output>): Flag<Output, Input>
export function defineFlag<Input, Output>(
  name: string,
  options: FlagOptions<Primitive> | TypedFlagOptions<Input, Output>
): Flag<Output | Primitive, Input | Primitive> {
  const validate = 'schema' in options ? schemaValidator(options.schema) : primitiveValidator(options.default)
  const defaultValue = validate(options.default)
  const jsonSchema = 'schema' in options ? getJsonSchema(options.schema) : { type: typeof defaultValue }
  const variable = registerFeatureFlag(name, {
    codec: { parse: validate, ...(jsonSchema === undefined ? {} : { jsonSchema }) },
    default: defaultValue,
    ...(options.description === undefined ? {} : { description: options.description }),
  })
  let declared = false

  async function details(context: FeatureContext = {}): Promise<FlagDetails<Output | Primitive>> {
    const inputs = getFlagEvaluationInputs(context)
    const evaluate = async () => {
      const provider = getVariableProvider()
      const result = await variable.evaluate(inputs.targetingKey, inputs.attributes, inputs.overrides)
      return { result, details: toFlagDetails(result, provider.getFlagProviderState?.() ?? 'ready') }
    }
    if (!shouldInstrumentFeatureFlags()) {
      return (await evaluate()).details
    }
    return span('feature_flag.evaluation', {
      attributes: { 'feature_flag.key': name, 'feature_flag.provider.name': 'logfire' },
      async callback(evaluationSpan) {
        if (!declared && evaluationSpan.isRecording()) {
          declared = true
          try {
            declared = declareFlag(variable, jsonSchema)
          } catch {
            // Declaration telemetry is best effort.
          }
        }
        const { result, details: evaluated } = await evaluate()
        evaluationSpan.setAttribute('feature_flag.key', evaluated.flagKey)
        evaluationSpan.setAttribute('feature_flag.result.reason', evaluated.reason)
        if (evaluated.errorCode !== undefined) {
          evaluationSpan.setAttribute('error.type', evaluated.errorCode)
        }
        if (evaluated.variant !== undefined) {
          evaluationSpan.setAttribute('feature_flag.result.variant', evaluated.variant)
        }
        if (evaluated.valueVersion !== undefined) {
          evaluationSpan.setAttribute('logfire.feature_flag.value_version', evaluated.valueVersion)
        }
        if (
          (evaluated.reason === 'static' || evaluated.reason === 'split' || evaluated.reason === 'targeting_match') &&
          !inputs.anonymous &&
          result.experimentRevision !== undefined &&
          inputs.targetingKey !== undefined
        ) {
          evaluationSpan.setAttribute('logfire.feature_flag.experiment_revision', result.experimentRevision)
        }
        if (evaluated.errorCode === undefined && typeof evaluated.value === 'boolean') {
          evaluationSpan.setAttribute('feature_flag.result.value', evaluated.value)
        }
        return evaluated
      },
    })
  }

  return {
    name,
    description: options.description,
    async value(context) {
      return (await details(context)).value
    },
    details,
    override(value, callback) {
      return withFlagOverride(variable, validate(value), callback)
    },
  }
}

function primitiveValidator(defaultValue: Primitive): (value: unknown) => Primitive {
  const type = typeof defaultValue
  if (type !== 'boolean' && type !== 'number' && type !== 'string') {
    throw new TypeError('Structured feature flags require a schema')
  }
  return (value) => {
    const valueType = typeof value
    if (valueType !== type || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError(`Expected a feature flag value of type ${type}`)
    }
    return value as Primitive
  }
}

function schemaValidator<T>(schema: StandardSchemaV1<unknown, T>): (value: unknown) => T {
  return (value) => {
    const valid = schema['~standard'].validate(value)
    if ('then' in valid) {
      valid.catch(() => undefined)
      throw new TypeError('Feature flag schemas must validate synchronously')
    }
    if (valid.issues !== undefined) {
      throw new TypeError('Value does not match the feature flag schema')
    }
    return structuredClone(valid.value)
  }
}

function getJsonSchema(schema: TypedFlagOptions<unknown, unknown>['schema']): JsonSchema | undefined {
  try {
    return schema['~standard'].jsonSchema?.input({ target: 'draft-2020-12' })
  } catch {
    return undefined
  }
}

function toFlagDetails<T>(result: ResolvedVariable<T>, state: 'ready' | 'stale' | 'not_ready' | 'error'): FlagDetails<T> {
  const details: FlagDetails<T> = { flagKey: result.name, reason: 'default', value: structuredClone(result.value) }
  if (result.reason === 'context_override') {
    return { ...details, reason: 'context_override' }
  }
  const errorCode = errorForResolution(result.reason, state)
  if (errorCode !== undefined) {
    return { ...details, reason: 'error', errorCode }
  }
  if (state === 'stale') {
    details.reason = 'stale'
  } else if (result.reason === 'resolved') {
    details.reason = result.ruleReason ?? 'static'
  }
  if (result.label !== undefined) {
    details.variant = result.label
  }
  if (result.version !== undefined) {
    details.valueVersion = result.version
  }
  return details
}

function errorForResolution(reason: ResolvedVariable<unknown>['reason'], state: string): FlagDetails<unknown>['errorCode'] {
  if (state === 'not_ready') {
    return 'provider_not_ready'
  }
  if (state === 'error' || reason === 'other_error') {
    return 'general'
  }
  if (reason === 'validation_error') {
    return 'type_mismatch'
  }
  if (reason === 'unrecognized_variable') {
    return 'flag_not_found'
  }
  if (reason === 'missing_targeting_key') {
    return 'targeting_key_missing'
  }
  return undefined
}

function declareFlag<T>(variable: FeatureFlagVariable<T>, schema: JsonSchema | undefined): boolean {
  // Use the same event shape as Python. Structured defaults can contain sensitive
  // values, so this declaration includes only boolean defaults.
  const attributes: Record<string, unknown> = {
    'logfire.variable.declaration': true,
    'logfire.variable.declaration_version': 1,
    'logfire.variable.kind': 'feature_flag',
    'logfire.variable.name': variable.name,
    'logfire.variable.code_default_status': typeof variable.defaultValue === 'boolean' ? 'available' : 'unavailable',
  }
  if (variable.description !== undefined) {
    attributes['logfire.variable.description'] = variable.description.slice(0, 500)
  }
  if (typeof variable.defaultValue === 'boolean') {
    attributes['logfire.variable.code_default'] = JSON.stringify(variable.defaultValue)
  }
  try {
    const serialized =
      schema === undefined
        ? undefined
        : JSON.stringify(schema, (key, value: unknown) =>
            key === 'default' || key === 'examples' || key === 'example' ? undefined : value
          )
    if (serialized !== undefined && new TextEncoder().encode(serialized).length <= 16_384) {
      attributes['logfire.variable.schema'] = serialized
    }
  } catch {
    // A schema that cannot be serialized should not prevent evaluating the flag.
  }
  const declaration = startSpan(`Declare variable ${variable.name}`, attributes)
  const recording = declaration.isRecording()
  declaration.end()
  return recording
}
