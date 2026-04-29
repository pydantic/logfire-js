/**
 * Dataset YAML / JSON / object serialization.
 *
 * Wire format mirrors pydantic-evals (so a `.yaml` produced by Python is
 * readable by TS and vice versa, modulo the constructor-argument convention
 * differences for custom evaluators).
 */

import { z } from 'zod'

import type { EvaluatorClass, ReportEvaluatorClass } from '../types'

import { Case } from '../Case'
import { Dataset } from '../Dataset'
import { getEvaluatorClass, getReportEvaluatorClass, listRegisteredEvaluators, listRegisteredReportEvaluators } from '../registry'
import { BUILTIN_PRIMARY_ARG_KEYS } from './builtinsPrimaryArgs'
import { decodeEvaluator, decodeReportEvaluator, type EncodedEvaluator, encodeEvaluatorSpec } from './spec'

export interface FromOptions {
  customEvaluators?: readonly EvaluatorClass[]
  customReportEvaluators?: readonly ReportEvaluatorClass[]
  /** Default dataset name when the YAML / JSON omits `name`. Falls back to `'dataset'`. */
  defaultName?: string
  /** Map of evaluator-name → primary-arg-key for constructing single-positional short forms. */
  primaryArgKeys?: Record<string, string>
}

export interface ToOptions {
  /** Path to the JSON Schema sidecar file referenced from the dataset's first line / `$schema` key. */
  schemaPath?: string
}

export interface SerializedCase {
  evaluators?: EncodedEvaluator[]
  expected_output?: unknown
  inputs: unknown
  metadata?: unknown
  name?: string
}

export interface SerializedDataset {
  $schema?: string
  cases: SerializedCase[]
  evaluators?: EncodedEvaluator[]
  name: string
  report_evaluators?: EncodedEvaluator[]
}

const encodedEvaluatorSchema: z.ZodType<EncodedEvaluator> = z.union([z.string(), z.record(z.unknown())])
const serializedCaseSchema = z.object({
  evaluators: z.array(encodedEvaluatorSchema).optional(),
  expected_output: z.unknown().optional(),
  inputs: z.unknown(),
  metadata: z.unknown().optional(),
  name: z.string().optional(),
})
const serializedDatasetSchema = z.object({
  $schema: z.string().optional(),
  cases: z.array(serializedCaseSchema),
  evaluators: z.array(encodedEvaluatorSchema).optional(),
  // Optional — defaults to the source file stem (or `'dataset'` for raw text).
  name: z.string().optional(),
  report_evaluators: z.array(encodedEvaluatorSchema).optional(),
})

export function datasetToObject<I, O, M>(dataset: Dataset<I, O, M>, options: ToOptions = {}): SerializedDataset {
  const out: SerializedDataset = {
    cases: dataset.cases.map(serializeCase),
    name: dataset.name,
  }
  if (dataset.evaluators.length > 0) out.evaluators = dataset.evaluators.map((e) => encodeEvaluatorSpec(e))
  if (dataset.reportEvaluators.length > 0) {
    out.report_evaluators = dataset.reportEvaluators.map((e) => encodeEvaluatorSpec(e))
  }
  if (options.schemaPath !== undefined) out.$schema = options.schemaPath
  return out
}

export function datasetFromObject<I = unknown, O = unknown, M = unknown>(data: unknown, options: FromOptions = {}): Dataset<I, O, M> {
  const parsed = serializedDatasetSchema.parse(data)
  const evaluatorRegistry = buildRegistry<EvaluatorClass<I, O, M>>(
    listRegisteredEvaluators() as readonly EvaluatorClass<I, O, M>[],
    options.customEvaluators as readonly EvaluatorClass<I, O, M>[] | undefined,
    getEvaluatorClass as (name: string) => EvaluatorClass<I, O, M> | undefined
  )
  const reportRegistry = buildRegistry<ReportEvaluatorClass<I, O, M>>(
    listRegisteredReportEvaluators() as readonly ReportEvaluatorClass<I, O, M>[],
    options.customReportEvaluators as readonly ReportEvaluatorClass<I, O, M>[] | undefined,
    getReportEvaluatorClass as (name: string) => ReportEvaluatorClass<I, O, M> | undefined
  )
  const primaryArgKeys = new Map(Object.entries({ ...BUILTIN_PRIMARY_ARG_KEYS, ...options.primaryArgKeys }))

  const cases = parsed.cases.map((c) => {
    const ev = (c.evaluators ?? []).map((e) => decodeEvaluator<I, O, M>(e, evaluatorRegistry, primaryArgKeys))
    return new Case<I, O, M>({
      evaluators: ev,
      expectedOutput: c.expected_output as O | undefined,
      inputs: c.inputs as I,
      metadata: c.metadata as M | undefined,
      name: c.name,
    })
  })
  const evaluators = (parsed.evaluators ?? []).map((e) => decodeEvaluator<I, O, M>(e, evaluatorRegistry, primaryArgKeys))
  const reportEvaluators = (parsed.report_evaluators ?? []).map((e) => decodeReportEvaluator<I, O, M>(e, reportRegistry, primaryArgKeys))
  return new Dataset<I, O, M>({
    cases,
    evaluators,
    name: parsed.name ?? options.defaultName ?? 'dataset',
    reportEvaluators,
  })
}

function serializeCase<I, O, M>(c: Case<I, O, M>): SerializedCase {
  const out: SerializedCase = { inputs: c.inputs }
  if (c.name !== undefined) out.name = c.name
  if (c.expectedOutput !== undefined) out.expected_output = c.expectedOutput
  if (c.metadata !== undefined) out.metadata = c.metadata
  if (c.evaluators.length > 0) out.evaluators = c.evaluators.map((e) => encodeEvaluatorSpec(e))
  return out
}

function buildRegistry<T extends { evaluatorName?: string; name: string }>(
  defaults: readonly T[],
  custom: readonly T[] | undefined,
  globalLookup: (name: string) => T | undefined
): Map<string, T> {
  const map = new Map<string, T>()
  for (const cls of defaults) {
    map.set(cls.evaluatorName ?? cls.name, cls)
  }
  if (custom !== undefined) {
    for (const cls of custom) {
      map.set(cls.evaluatorName ?? cls.name, cls)
    }
  }
  // Fallback: also try the global registry (in case the user didn't explicitly
  // pass `customEvaluators` but did `registerEvaluator` somewhere).
  return new Proxy(map, {
    get(target, prop, receiver): unknown {
      if (prop === 'get') {
        return (key: string): T | undefined => target.get(key) ?? globalLookup(key)
      }
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
}
