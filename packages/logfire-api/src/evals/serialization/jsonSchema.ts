/**
 * JSON Schema generation for dataset files.
 *
 * Produces a schema where `evaluators` is a union of the forms `decodeEvaluator` accepts for
 * each registered evaluator: the bare name when it needs no arguments, `{Name: value}` for a
 * lone argument, and `{Name: {kwargs}}`. IDEs with YAML language servers use it for completion
 * and validation of `pydantic-evals`-style dataset files.
 *
 * Mirrors pydantic-evals' `Dataset.model_json_schema_with_evaluators`.
 */

import type { EvaluatorClass, ReportEvaluatorClass } from '../types'

import { evaluatorRegistryKey, listRegisteredEvaluators, listRegisteredReportEvaluators } from '../registry'
import { BUILTIN_PRIMARY_ARG_KEYS } from './builtinsPrimaryArgs'

interface JsonSchemaOptions {
  customEvaluators?: readonly EvaluatorClass[]
  customReportEvaluators?: readonly ReportEvaluatorClass[]
  /**
   * Primary-argument key per evaluator name, merged over the builtin map. Mirrors the option
   * `FromOptions` already accepts, so a custom evaluator that decodes from `{Name: value}` can
   * also validate against a generated schema.
   */
  primaryArgKeys?: Readonly<Record<string, string>> | ReadonlyMap<string, string>
}

export interface JsonSchema {
  $schema?: string
  [key: string]: unknown
}

/** A class can opt in to schema-driven validation by exposing this static. */
interface HasSchemaDescriptor {
  jsonSchema?: () => JsonSchema | null
}

export function buildDatasetJsonSchema(opts: JsonSchemaOptions = {}): JsonSchema {
  const evaluators = dedupeByRegistryKey([...listRegisteredEvaluators(), ...(opts.customEvaluators ?? [])])
  const reportEvaluators = dedupeByRegistryKey([...listRegisteredReportEvaluators(), ...(opts.customReportEvaluators ?? [])])

  const primaryArgKeys = mergePrimaryArgKeys(opts.primaryArgKeys)
  const evaluatorAnyOf = buildEvaluatorAnyOf(evaluators, primaryArgKeys)
  const reportAnyOf = buildEvaluatorAnyOf(reportEvaluators, primaryArgKeys)

  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      cases: {
        items: {
          additionalProperties: false,
          properties: {
            evaluators: { items: evaluatorAnyOf, type: 'array' },
            expected_output: {},
            inputs: {},
            metadata: {},
            name: { type: 'string' },
          },
          required: ['inputs'],
          type: 'object',
        },
        type: 'array',
      },
      evaluators: { items: evaluatorAnyOf, type: 'array' },
      name: { type: 'string' },
      report_evaluators: { items: reportAnyOf, type: 'array' },
    },
    required: ['name', 'cases'],
    title: 'PydanticEvalsDataset',
    type: 'object',
  }
}

/**
 * A class passed as a custom evaluator is often registered as well. Emitting it
 * twice would put two identical branches in `oneOf`, which requires exactly one
 * match, so a file naming that evaluator would fail to validate.
 */
function dedupeByRegistryKey<T extends { evaluatorName?: string; name: string }>(classes: readonly T[]): T[] {
  const byKey = new Map<string, T>()
  for (const cls of classes) {
    byKey.set(evaluatorRegistryKey(cls), cls)
  }
  return [...byKey.values()]
}

function mergePrimaryArgKeys(overrides: JsonSchemaOptions['primaryArgKeys']): ReadonlyMap<string, string> {
  const merged = new Map(Object.entries(BUILTIN_PRIMARY_ARG_KEYS))
  if (overrides !== undefined) {
    const entries: Iterable<readonly [string, string]> = overrides instanceof Map ? overrides.entries() : Object.entries(overrides)
    for (const [name, key] of entries) {
      merged.set(name, key)
    }
  }
  return merged
}

function buildEvaluatorAnyOf(
  classes: readonly (EvaluatorClass | ReportEvaluatorClass)[],
  primaryArgKeys: ReadonlyMap<string, string>
): JsonSchema {
  // `anyOf`, not `oneOf`: an evaluator whose single argument is untyped matches both its short
  // and its long branch, and `oneOf` demands exactly one match. Python's schema is a union,
  // which pydantic also renders as `anyOf`.
  const anyOf: JsonSchema[] = []
  for (const cls of classes) {
    const name = cls.evaluatorName ?? cls.name
    const schemaProvider = cls as unknown as HasSchemaDescriptor
    const argSchema = typeof schemaProvider.jsonSchema === 'function' ? schemaProvider.jsonSchema() : null
    if (argSchema === null) {
      // No schema provider; allow the bare name, a single positional value, or a kwargs object.
      anyOf.push({ const: name, type: 'string' })
      anyOf.push(namedBranch(name, {}))
      continue
    }
    const properties = isRecord(argSchema['properties']) ? argSchema['properties'] : {}
    const required = Array.isArray(argSchema['required']) ? (argSchema['required'] as string[]) : []
    // The bare name constructs the evaluator with no arguments, so it is only valid when the
    // evaluator has none that are required.
    if (required.length === 0) {
      anyOf.push({ const: name, type: 'string' })
    }
    // `{Name: value}` is what `encodeEvaluatorSpec` writes for a lone argument, and it writes it
    // for ANY evaluator whose `toJSON()` has exactly one key. Keying this off the builtin map
    // alone left single-parameter evaluators such as `EqualsExpected` without a short branch, so
    // the library emitted a file its own schema rejected. Fall back to parameter count, which is
    // what Python keys on (`_spec.py:320-338`).
    const onlyProperty = Object.keys(properties).length === 1 ? Object.keys(properties)[0] : undefined
    const shortArgKey = primaryArgKeys.get(name) ?? onlyProperty
    if (shortArgKey !== undefined) {
      const shortSchema = properties[shortArgKey]
      anyOf.push(namedBranch(name, isRecord(shortSchema) ? shortSchema : {}))
    }
    anyOf.push(namedBranch(name, argSchema))
  }
  return { anyOf }
}

function namedBranch(name: string, valueSchema: Record<string, unknown>): JsonSchema {
  return {
    additionalProperties: false,
    properties: { [name]: valueSchema },
    required: [name],
    type: 'object',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
