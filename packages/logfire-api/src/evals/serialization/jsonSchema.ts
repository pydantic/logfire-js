/**
 * JSON Schema generation for dataset files.
 *
 * Produces a schema where `evaluators` is a discriminated union of one entry
 * per registered evaluator (plus the bare-name string), so IDEs with YAML
 * language servers offer completion + validation against `pydantic-evals`-style
 * dataset files.
 *
 * Mirrors pydantic-evals' `Dataset.model_json_schema_with_evaluators`.
 */

import type { EvaluatorClass, ReportEvaluatorClass } from '../types'

import { evaluatorRegistryKey, listRegisteredEvaluators, listRegisteredReportEvaluators } from '../registry'

interface JsonSchemaOptions {
  customEvaluators?: readonly EvaluatorClass[]
  customReportEvaluators?: readonly ReportEvaluatorClass[]
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

  const evaluatorOneOf = buildEvaluatorOneOf(evaluators)
  const reportOneOf = buildEvaluatorOneOf(reportEvaluators)

  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      cases: {
        items: {
          additionalProperties: false,
          properties: {
            evaluators: { items: evaluatorOneOf, type: 'array' },
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
      evaluators: { items: evaluatorOneOf, type: 'array' },
      name: { type: 'string' },
      report_evaluators: { items: reportOneOf, type: 'array' },
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

function buildEvaluatorOneOf(classes: readonly (EvaluatorClass | ReportEvaluatorClass)[]): JsonSchema {
  const oneOf: JsonSchema[] = []
  for (const cls of classes) {
    const name = cls.evaluatorName ?? cls.name
    oneOf.push({ const: name, type: 'string' })
    const schemaProvider = cls as unknown as HasSchemaDescriptor
    if (typeof schemaProvider.jsonSchema === 'function') {
      const argSchema = schemaProvider.jsonSchema()
      if (argSchema !== null) {
        oneOf.push({
          additionalProperties: false,
          properties: { [name]: argSchema },
          required: [name],
          type: 'object',
        })
        continue
      }
    }
    // No schema provider; allow either single positional value or kwargs object.
    oneOf.push({
      additionalProperties: false,
      properties: { [name]: {} },
      required: [name],
      type: 'object',
    })
  }
  return { oneOf }
}
