import { Case, Dataset } from '../evals'
import type { EncodedEvaluator, Evaluator, EvaluatorClass, ReportEvaluator, ReportEvaluatorClass, SerializedDataset } from '../evals'

import { DatasetSerializationError, normalizeHostedJsonValue } from './json'
import type {
  CaseConflictBehavior,
  CreateCaseOptions,
  CreateDatasetOptions,
  HostedEvaluatorSpec,
  JsonObject,
  JsonSchema,
  UpdateDatasetOptions,
} from './index'

export interface EvaluationDatasetValueContext {
  caseIndex?: number
  caseName?: string
  field: 'evaluatorArguments' | 'expectedOutput' | 'inputs' | 'metadata'
  path: string
}

export type EvaluationDatasetValueSerializer = (value: unknown, context: EvaluationDatasetValueContext) => unknown
export type EvaluationDatasetValueParser<T> = (value: unknown, context: EvaluationDatasetValueContext) => T

export interface PushEvaluationDatasetOptions {
  description?: null | string
  inputSchema?: JsonSchema | null
  metadataSchema?: JsonSchema | null
  name?: string
  onCaseConflict?: CaseConflictBehavior
  outputSchema?: JsonSchema | null
  serializeValue?: EvaluationDatasetValueSerializer
}

export interface GetEvaluationDatasetOptions<Inputs = unknown, Output = unknown, Metadata = unknown> {
  customEvaluators?: readonly EvaluatorClass<Inputs, Output, Metadata>[]
  customReportEvaluators?: readonly ReportEvaluatorClass<Inputs, Output, Metadata>[]
  parseExpectedOutput?: EvaluationDatasetValueParser<Output>
  parseInputs?: EvaluationDatasetValueParser<Inputs>
  parseMetadata?: EvaluationDatasetValueParser<Metadata>
  primaryArgKeys?: Record<string, string>
}

export function resolveEvaluationDatasetName<Inputs, Output, Metadata>(
  dataset: Dataset<Inputs, Output, Metadata>,
  options: PushEvaluationDatasetOptions
): string | undefined {
  const name = (options.name ?? dataset.name).trim()
  return name === '' ? undefined : name
}

export function evaluationDatasetCreateOptions<Inputs, Output, Metadata>(
  dataset: Dataset<Inputs, Output, Metadata>,
  targetName: string,
  options: PushEvaluationDatasetOptions
): CreateDatasetOptions {
  const result: CreateDatasetOptions = {
    evaluators: hostedEvaluatorSpecs(dataset.evaluators, {
      path: '$.evaluators',
      serializeValue: options.serializeValue,
    }),
    name: targetName,
    reportEvaluators: hostedEvaluatorSpecs(dataset.reportEvaluators, {
      path: '$.report_evaluators',
      serializeValue: options.serializeValue,
    }),
  }
  addDatasetWriteOptions(result, options)
  return result
}

export function evaluationDatasetUpdateOptions<Inputs, Output, Metadata>(
  dataset: Dataset<Inputs, Output, Metadata>,
  options: PushEvaluationDatasetOptions
): UpdateDatasetOptions {
  const result: UpdateDatasetOptions = {
    evaluators: hostedEvaluatorSpecs(dataset.evaluators, {
      path: '$.evaluators',
      serializeValue: options.serializeValue,
    }),
    reportEvaluators: hostedEvaluatorSpecs(dataset.reportEvaluators, {
      path: '$.report_evaluators',
      serializeValue: options.serializeValue,
    }),
  }
  addDatasetWriteOptions(result, options)
  return result
}

export function evaluationDatasetCaseOptions<Inputs, Output, Metadata>(
  dataset: Dataset<Inputs, Output, Metadata>,
  options: PushEvaluationDatasetOptions
): CreateCaseOptions[] {
  return dataset.cases.map((c, caseIndex) => {
    const context = caseContext(c, caseIndex)
    const out: CreateCaseOptions = {
      evaluators: hostedEvaluatorSpecs(c.evaluators, {
        caseIndex,
        ...(c.name !== undefined ? { caseName: c.name } : {}),
        path: `$.cases[${caseIndex.toString()}].evaluators`,
        serializeValue: options.serializeValue,
      }),
      inputs: normalizeCaseValue(c.inputs, { ...context, field: 'inputs', path: `$.cases[${caseIndex.toString()}].inputs` }, options),
    }
    if (c.name !== undefined) {
      out.name = c.name
    }
    if (c.expectedOutput !== undefined) {
      out.expectedOutput = normalizeCaseValue(
        c.expectedOutput,
        { ...context, field: 'expectedOutput', path: `$.cases[${caseIndex.toString()}].expected_output` },
        options
      )
    }
    if (c.metadata !== undefined) {
      out.metadata = normalizeCaseValue(
        c.metadata,
        { ...context, field: 'metadata', path: `$.cases[${caseIndex.toString()}].metadata` },
        options
      )
    }
    return out
  })
}

export function evaluationDatasetFromHostedExport<Inputs = unknown, Output = unknown, Metadata = unknown>(
  value: unknown,
  defaultName: string,
  options: GetEvaluationDatasetOptions<Inputs, Output, Metadata> = {}
): Dataset<Inputs, Output, Metadata> {
  const hosted = requireRecord(value, 'hosted dataset export')
  const cases = requireArray(hosted['cases'], 'hosted dataset export cases')
  const serialized: SerializedDataset = {
    cases: cases.map((item, caseIndex) => serializedCaseFromHosted(item, caseIndex)),
    name: typeof hosted['name'] === 'string' && hosted['name'].trim() !== '' ? hosted['name'] : defaultName,
  }
  if (hosted['evaluators'] !== undefined) {
    serialized.evaluators = encodedEvaluatorList(hosted['evaluators'], '$.evaluators')
  }
  if (hosted['report_evaluators'] !== undefined) {
    serialized.report_evaluators = encodedEvaluatorList(hosted['report_evaluators'], '$.report_evaluators')
  }

  const decoded = Dataset.fromObject<Inputs, Output, Metadata>(serialized, {
    ...(options.customEvaluators !== undefined ? { customEvaluators: options.customEvaluators } : {}),
    ...(options.customReportEvaluators !== undefined ? { customReportEvaluators: options.customReportEvaluators } : {}),
    ...(options.primaryArgKeys !== undefined ? { primaryArgKeys: options.primaryArgKeys } : {}),
  })

  if (options.parseInputs === undefined && options.parseExpectedOutput === undefined && options.parseMetadata === undefined) {
    return decoded
  }

  return new Dataset<Inputs, Output, Metadata>({
    cases: decoded.cases.map((c, caseIndex) => parseCase(c, caseIndex, options)),
    evaluators: decoded.evaluators,
    name: decoded.name,
    reportEvaluators: decoded.reportEvaluators,
  })
}

function hostedEvaluatorSpecs(
  evaluators: readonly (Evaluator | ReportEvaluator)[],
  options: {
    caseIndex?: number
    caseName?: string
    path: string
    serializeValue: EvaluationDatasetValueSerializer | undefined
  }
): HostedEvaluatorSpec[] {
  return evaluators.map((evaluator, index) => {
    const spec = evaluator.getSpec()
    const context: EvaluationDatasetValueContext = {
      ...(options.caseIndex !== undefined ? { caseIndex: options.caseIndex } : {}),
      ...(options.caseName !== undefined ? { caseName: options.caseName } : {}),
      field: 'evaluatorArguments',
      path: `${options.path}[${index.toString()}].arguments`,
    }
    return {
      arguments: normalizeEvaluatorArguments(spec.arguments, context, options.serializeValue),
      name: spec.name,
    }
  })
}

function addDatasetWriteOptions(result: CreateDatasetOptions | UpdateDatasetOptions, options: PushEvaluationDatasetOptions): void {
  if (options.description !== undefined) {
    result.description = options.description
  }
  if (options.inputSchema !== undefined) {
    result.inputSchema = options.inputSchema
  }
  if (options.metadataSchema !== undefined) {
    result.metadataSchema = options.metadataSchema
  }
  if (options.outputSchema !== undefined) {
    result.outputSchema = options.outputSchema
  }
}

function normalizeEvaluatorArguments(
  value: null | Record<string, unknown> | unknown[],
  context: EvaluationDatasetValueContext,
  serializeValue: EvaluationDatasetValueSerializer | undefined
): HostedEvaluatorSpec['arguments'] {
  const normalized = normalizeHostedJsonValue(value, context, serializeValue)
  if (normalized === null) {
    return null
  }
  if (isUnknownArray(normalized)) {
    if (normalized.length === 0) {
      return null
    }
    if (normalized.length > 1) {
      throw new DatasetSerializationError(
        `pushEvaluationDataset evaluatorArguments at ${context.path} cannot use multi-element positional argument arrays`
      )
    }
    return normalized
  }
  if (isJsonObject(normalized)) {
    return Object.keys(normalized).length === 0 ? null : normalized
  }
  throw new DatasetSerializationError(
    `pushEvaluationDataset evaluatorArguments at ${context.path} must serialize to an object, array, or null`
  )
}

function normalizeCaseValue(value: unknown, context: EvaluationDatasetValueContext, options: PushEvaluationDatasetOptions): unknown {
  return normalizeHostedJsonValue(value, context, options.serializeValue)
}

function serializedCaseFromHosted(value: unknown, caseIndex: number): SerializedDataset['cases'][number] {
  const hostedCase = requireRecord(value, `hosted dataset export case ${caseIndex.toString()}`)
  const serialized: SerializedDataset['cases'][number] = {
    inputs: hostedCase['inputs'],
  }
  if (typeof hostedCase['name'] === 'string') {
    serialized.name = hostedCase['name']
  }
  if (hasOwn(hostedCase, 'expected_output')) {
    serialized.expected_output = hostedCase['expected_output']
  }
  if (hasOwn(hostedCase, 'metadata')) {
    serialized.metadata = hostedCase['metadata']
  }
  if (hostedCase['evaluators'] !== undefined) {
    serialized.evaluators = encodedEvaluatorList(hostedCase['evaluators'], `$.cases[${caseIndex.toString()}].evaluators`)
  }
  return serialized
}

function encodedEvaluatorList(value: unknown, path: string): EncodedEvaluator[] {
  const specs = requireArray(value, `${path} evaluator list`)
  return specs.map((spec, index) => encodedEvaluatorFromHosted(spec, `${path}[${index.toString()}]`))
}

function encodedEvaluatorFromHosted(value: unknown, path: string): EncodedEvaluator {
  if (isExplicitHostedEvaluatorSpec(value)) {
    const name = value.name
    const args = value.arguments
    if (args === null) {
      return name
    }
    if (Array.isArray(args)) {
      return { [name]: args }
    }
    if (isJsonObject(args)) {
      return { [name]: args }
    }
    throw new Error(`Hosted evaluator spec at ${path} has unsupported arguments`)
  }
  if (typeof value === 'string' || isJsonObject(value)) {
    return value
  }
  throw new Error(`Hosted evaluator spec at ${path} must be a hosted spec or compact evaluator encoding`)
}

function parseCase<Inputs, Output, Metadata>(
  c: Case<Inputs, Output, Metadata>,
  caseIndex: number,
  options: GetEvaluationDatasetOptions<Inputs, Output, Metadata>
): Case<Inputs, Output, Metadata> {
  const context = caseContext(c, caseIndex)
  const parsedInputs =
    options.parseInputs === undefined
      ? c.inputs
      : options.parseInputs(c.inputs, { ...context, field: 'inputs', path: `$.cases[${caseIndex.toString()}].inputs` })
  const caseOptions = {
    evaluators: c.evaluators,
    inputs: parsedInputs,
    ...(c.name !== undefined ? { name: c.name } : {}),
  }
  if (c.expectedOutput !== undefined) {
    Object.assign(caseOptions, {
      expectedOutput:
        options.parseExpectedOutput === undefined
          ? c.expectedOutput
          : options.parseExpectedOutput(c.expectedOutput, {
              ...context,
              field: 'expectedOutput',
              path: `$.cases[${caseIndex.toString()}].expected_output`,
            }),
    })
  }
  if (c.metadata !== undefined) {
    Object.assign(caseOptions, {
      metadata:
        options.parseMetadata === undefined
          ? c.metadata
          : options.parseMetadata(c.metadata, { ...context, field: 'metadata', path: `$.cases[${caseIndex.toString()}].metadata` }),
    })
  }
  return new Case<Inputs, Output, Metadata>(caseOptions)
}

function caseContext<Inputs, Output, Metadata>(
  c: Case<Inputs, Output, Metadata>,
  caseIndex: number
): Pick<EvaluationDatasetValueContext, 'caseIndex' | 'caseName'> {
  return {
    caseIndex,
    ...(c.name !== undefined ? { caseName: c.name } : {}),
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  return value
}

function isExplicitHostedEvaluatorSpec(value: unknown): value is { arguments: unknown; name: string } {
  return isJsonObject(value) && typeof value['name'] === 'string' && hasOwn(value, 'arguments')
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key)
}
