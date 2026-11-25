import { startSpan } from 'logfire'
import type { Span } from '@opentelemetry/api'
import { registerFeatureFlag, shouldInstrumentFeatureFlags } from 'logfire/vars'
import type { FeatureFlagVariable, JsonSchema } from 'logfire/vars'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

import { toFlagDetails } from './featureFlagDetails'
import type { FlagDetails } from './featureFlagDetails'
import { getFlagEvaluationInputs, withFlagOverride } from './featureFlagContext'
import type { FeatureContext } from './featureFlagContext'
import { schemaForDiscovery } from './featureFlagSchema'
import { cloneSchemaOutput } from './featureFlagValue'

export { withFeatureContext } from './featureFlagContext'
export type { FeatureContext } from './featureFlagContext'

export type { FlagDetails } from './featureFlagDetails'

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
    const evaluationSpan = shouldInstrumentFeatureFlags() ? startEvaluationSpan(name) : undefined
    try {
      if (!declared && evaluationSpan !== undefined) {
        declared = true
        try {
          declared = declareFlag(variable, jsonSchema, evaluationSpan)
        } catch {
          declared = false
        }
      }
      const { result, state } = await variable.evaluate(inputs.targetingKey, inputs.attributes, inputs.overrides)
      const evaluated = toFlagDetails(result, state)
      if (evaluationSpan !== undefined) {
        const hasExposure =
          (evaluated.reason === 'static' || evaluated.reason === 'split' || evaluated.reason === 'targeting_match') &&
          !inputs.anonymous &&
          inputs.targetingKey !== undefined
        recordEvaluation(evaluationSpan, evaluated, hasExposure ? result.experimentRevision : undefined)
      }
      return evaluated
    } finally {
      try {
        evaluationSpan?.end()
      } catch {
        // A span processor must not replace the application's result.
      }
    }
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
    return cloneSchemaOutput(valid.value)
  }
}

function getJsonSchema(schema: TypedFlagOptions<unknown, unknown>['schema']): JsonSchema | undefined {
  try {
    return schema['~standard'].jsonSchema?.input({ target: 'draft-2020-12' })
  } catch {
    return undefined
  }
}

function startEvaluationSpan(name: string): Span | undefined {
  try {
    const span = startSpan('feature_flag.evaluation', { 'feature_flag.key': name, 'feature_flag.provider.name': 'logfire' })
    if (span.isRecording()) {
      return span
    }
    span.end()
  } catch {
    // A tracer or span processor must not prevent evaluation.
  }
  return undefined
}

function recordEvaluation<T>(span: Span, result: FlagDetails<T>, experimentRevision: string | undefined): void {
  try {
    span.setAttributes({
      'feature_flag.key': result.flagKey,
      'feature_flag.result.reason': result.reason,
      ...(result.errorCode === undefined ? {} : { 'error.type': result.errorCode }),
      ...(result.variant === undefined ? {} : { 'feature_flag.result.variant': result.variant }),
      ...(result.valueVersion === undefined ? {} : { 'logfire.feature_flag.value_version': result.valueVersion }),
      ...(experimentRevision === undefined ? {} : { 'logfire.feature_flag.experiment_revision': experimentRevision }),
      ...(result.errorCode === undefined && typeof result.value === 'boolean' ? { 'feature_flag.result.value': result.value } : {}),
    })
  } catch {
    // Evaluation telemetry is best effort.
  }
}

function declareFlag<T>(variable: FeatureFlagVariable<T>, schema: JsonSchema | undefined, parentSpan: Span): boolean {
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
  const serialized = schemaForDiscovery(schema)
  if (serialized !== undefined) {
    attributes['logfire.variable.schema'] = serialized
  }
  const declaration = startSpan(`Declare variable ${variable.name}`, attributes, { parentSpan })
  const recording = declaration.isRecording()
  declaration.end()
  return recording
}
