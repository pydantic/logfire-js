import { resolveBaseUrl } from '../logfireApiConfig'
import { PlatformAPIClient, encodePathSegment } from '../platform/http'
import type { PlatformAPIClientOptions } from '../platform/http'
import { PlatformConfigurationError, PlatformHTTPError, PlatformTimeoutError, PlatformTransportError } from '../platform/errors'
import type { Dataset } from '../evals'

import {
  evaluationDatasetCaseOptions,
  evaluationDatasetCreateOptions,
  evaluationDatasetFromHostedExport,
  evaluationDatasetUpdateOptions,
  resolveEvaluationDatasetName,
} from './evaluation'
import type { GetEvaluationDatasetOptions, PushEvaluationDatasetOptions } from './evaluation'
import { DatasetSerializationError } from './json'

export type {
  EvaluationDatasetValueContext,
  EvaluationDatasetValueParser,
  EvaluationDatasetValueSerializer,
  GetEvaluationDatasetOptions,
  PushEvaluationDatasetOptions,
} from './evaluation'

export type JsonObject = Record<string, unknown>
export type JsonSchema = Record<string, unknown>

export interface HostedEvaluatorSpec {
  arguments: null | JsonObject | unknown[]
  name: string
}

export interface HostedDataset {
  case_count?: number
  created_at?: string
  description?: null | string
  evaluators?: HostedEvaluatorSpec[]
  id: string
  input_schema?: JsonSchema | null
  metadata_schema?: JsonSchema | null
  name: string
  output_schema?: JsonSchema | null
  report_evaluators?: HostedEvaluatorSpec[]
  updated_at?: string
  [key: string]: unknown
}

export interface HostedCase {
  created_at?: string
  evaluators?: HostedEvaluatorSpec[]
  expected_output?: unknown
  id: string
  inputs: unknown
  metadata?: unknown
  name?: null | string
  tags?: string[]
  updated_at?: string
  [key: string]: unknown
}

export interface CreateDatasetOptions {
  description?: null | string
  evaluators?: HostedEvaluatorSpec[]
  inputSchema?: JsonSchema | null
  metadataSchema?: JsonSchema | null
  name: string
  outputSchema?: JsonSchema | null
  reportEvaluators?: HostedEvaluatorSpec[]
}

export interface UpdateDatasetOptions {
  description?: null | string
  evaluators?: HostedEvaluatorSpec[] | null
  inputSchema?: JsonSchema | null
  metadataSchema?: JsonSchema | null
  name?: string
  outputSchema?: JsonSchema | null
  reportEvaluators?: HostedEvaluatorSpec[] | null
}

export interface CreateCaseOptions {
  evaluators?: HostedEvaluatorSpec[]
  expectedOutput?: unknown
  inputs: unknown
  metadata?: unknown
  name?: null | string
  tags?: string[]
}

export interface UpdateCaseOptions {
  evaluators?: HostedEvaluatorSpec[] | null
  expectedOutput?: unknown
  inputs?: unknown
  metadata?: unknown
  name?: null | string
  tags?: string[] | null
}

export type CaseConflictBehavior = 'error' | 'update'

export interface AddCasesOptions {
  onConflict?: CaseConflictBehavior
}

export interface GetDatasetOptions {
  includeCases?: boolean
}

export interface LogfireAPIClientOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export class DatasetNotFoundError extends Error {
  override name: string = 'DatasetNotFoundError'
  detail: unknown

  constructor(detail: unknown) {
    super(`Dataset not found: ${formatDetail(detail)}`)
    this.detail = detail
  }
}

export class CaseNotFoundError extends Error {
  override name: string = 'CaseNotFoundError'
  detail: unknown

  constructor(detail: unknown) {
    super(`Case not found: ${formatDetail(detail)}`)
    this.detail = detail
  }
}

export class DatasetApiError extends Error {
  override name: string = 'DatasetApiError'
  detail: unknown
  status: number

  constructor(status: number, detail: unknown) {
    super(`Dataset API error ${status.toString()}: ${formatDetail(detail)}`)
    this.detail = detail
    this.status = status
  }
}

export class DatasetTransportError extends Error {
  override name: string = 'DatasetTransportError'
}

export class DatasetConfigurationError extends DatasetTransportError {
  override name: string = 'DatasetConfigurationError'
}

export class DatasetTimeoutError extends DatasetTransportError {
  override name: string = 'DatasetTimeoutError'
}

export class LogfireAPIClient {
  private readonly transport: PlatformAPIClient

  constructor(options: LogfireAPIClientOptions) {
    const apiKey = readOptionalString((options as { apiKey?: unknown }).apiKey).trim()
    if (apiKey === '') {
      throw new DatasetConfigurationError('Logfire datasets API client requires an API key')
    }
    const baseUrl = resolveBaseUrl({}, normalizeBaseUrlOption(options.baseUrl), apiKey)
    const transportOptions: PlatformAPIClientOptions = {
      apiKey,
      baseUrl,
    }
    if (options.fetch !== undefined) {
      transportOptions.fetch = options.fetch
    }
    if (options.timeoutMs !== undefined) {
      transportOptions.timeoutMs = options.timeoutMs
    }
    try {
      this.transport = new PlatformAPIClient(transportOptions)
    } catch (error) {
      throw toDatasetError(error, false)
    }
  }

  async listDatasets(): Promise<HostedDataset[]> {
    return (await this.request('/v1/datasets/')) as HostedDataset[]
  }

  async createDataset(options: CreateDatasetOptions): Promise<HostedDataset> {
    return (await this.request('/v1/datasets/', {
      body: datasetCreateBody(options),
      method: 'POST',
    })) as HostedDataset
  }

  async updateDataset(idOrName: string, options: UpdateDatasetOptions = {}): Promise<HostedDataset> {
    return (await this.request(`/v1/datasets/${encodePathSegment(idOrName)}/`, {
      body: datasetUpdateBody(options),
      method: 'PATCH',
    })) as HostedDataset
  }

  async deleteDataset(idOrName: string): Promise<void> {
    await this.request(`/v1/datasets/${encodePathSegment(idOrName)}/`, { method: 'DELETE' })
  }

  async getDataset(idOrName: string, options: GetDatasetOptions = {}): Promise<HostedDataset | JsonObject> {
    const includeCases = options.includeCases ?? true
    const suffix = includeCases ? '/export/' : '/'
    return (await this.request(`/v1/datasets/${encodePathSegment(idOrName)}${suffix}`)) as HostedDataset | JsonObject
  }

  async pushEvaluationDataset<Inputs, Output, Metadata>(
    dataset: Dataset<Inputs, Output, Metadata>,
    options: PushEvaluationDatasetOptions = {}
  ): Promise<HostedDataset> {
    const targetName = resolveEvaluationDatasetName(dataset, options)
    if (targetName === undefined) {
      throw new DatasetConfigurationError('pushEvaluationDataset() requires a dataset name either on dataset.name or via options.name')
    }

    let createOptions: CreateDatasetOptions
    let updateOptions: UpdateDatasetOptions
    let cases: CreateCaseOptions[]
    try {
      createOptions = evaluationDatasetCreateOptions(dataset, targetName, options)
      updateOptions = evaluationDatasetUpdateOptions(dataset, options)
      cases = evaluationDatasetCaseOptions(dataset, options)
    } catch (error) {
      if (error instanceof DatasetSerializationError) {
        throw new DatasetConfigurationError(error.message)
      }
      throw error
    }

    try {
      await this.createDataset(createOptions)
    } catch (error) {
      if (!(error instanceof DatasetApiError) || error.status !== 409) {
        throw error
      }
      await this.updateDataset(targetName, updateOptions)
    }

    if (cases.length > 0) {
      await this.addCases(targetName, cases, { onConflict: options.onCaseConflict ?? 'update' })
    }

    return (await this.getDataset(targetName, { includeCases: false })) as HostedDataset
  }

  async getEvaluationDataset<Inputs = unknown, Output = unknown, Metadata = unknown>(
    idOrName: string,
    options: GetEvaluationDatasetOptions<Inputs, Output, Metadata> = {}
  ): Promise<Dataset<Inputs, Output, Metadata>> {
    return evaluationDatasetFromHostedExport<Inputs, Output, Metadata>(await this.getDataset(idOrName), idOrName, options)
  }

  async listCases(datasetIdOrName: string): Promise<HostedCase[]> {
    return (await this.request(`/v1/datasets/${encodePathSegment(datasetIdOrName)}/cases/`)) as HostedCase[]
  }

  async getCase(datasetIdOrName: string, caseId: string): Promise<HostedCase> {
    return (await this.request(`/v1/datasets/${encodePathSegment(datasetIdOrName)}/cases/${encodePathSegment(caseId)}/`, undefined, {
      isCaseEndpoint: true,
    })) as HostedCase
  }

  async addCases(datasetIdOrName: string, cases: readonly CreateCaseOptions[], options: AddCasesOptions = {}): Promise<HostedCase[]> {
    return (await this.request(`/v1/datasets/${encodePathSegment(datasetIdOrName)}/import/`, {
      body: { cases: cases.map(caseCreateBody) },
      method: 'POST',
      query: { on_conflict: options.onConflict ?? 'update' },
    })) as HostedCase[]
  }

  async updateCase(datasetIdOrName: string, caseId: string, options: UpdateCaseOptions): Promise<HostedCase> {
    return (await this.request(
      `/v1/datasets/${encodePathSegment(datasetIdOrName)}/cases/${encodePathSegment(caseId)}/`,
      {
        body: caseUpdateBody(options),
        method: 'PATCH',
      },
      { isCaseEndpoint: true }
    )) as HostedCase
  }

  async deleteCase(datasetIdOrName: string, caseId: string): Promise<void> {
    await this.request(
      `/v1/datasets/${encodePathSegment(datasetIdOrName)}/cases/${encodePathSegment(caseId)}/`,
      { method: 'DELETE' },
      {
        isCaseEndpoint: true,
      }
    )
  }

  private async request(
    path: string,
    options?: Parameters<PlatformAPIClient['requestJson']>[1],
    context: { isCaseEndpoint?: boolean } = {}
  ): Promise<unknown> {
    try {
      return await this.transport.requestJson(path, options)
    } catch (error) {
      throw toDatasetError(error, context.isCaseEndpoint ?? false)
    }
  }
}

function datasetCreateBody(options: CreateDatasetOptions): JsonObject {
  return omitUndefined({
    description: options.description,
    evaluators: options.evaluators,
    input_schema: options.inputSchema,
    metadata_schema: options.metadataSchema,
    name: options.name,
    output_schema: options.outputSchema,
    report_evaluators: options.reportEvaluators,
  })
}

function datasetUpdateBody(options: UpdateDatasetOptions): JsonObject {
  return omitUndefined({
    description: options.description,
    evaluators: options.evaluators,
    input_schema: options.inputSchema,
    metadata_schema: options.metadataSchema,
    name: options.name,
    output_schema: options.outputSchema,
    report_evaluators: options.reportEvaluators,
  })
}

function caseCreateBody(options: CreateCaseOptions): JsonObject {
  return omitUndefined({
    evaluators: options.evaluators,
    expected_output: options.expectedOutput,
    inputs: options.inputs,
    metadata: options.metadata,
    name: options.name,
    tags: options.tags,
  })
}

function caseUpdateBody(options: UpdateCaseOptions): JsonObject {
  return omitUndefined({
    evaluators: options.evaluators,
    expected_output: options.expectedOutput,
    inputs: options.inputs,
    metadata: options.metadata,
    name: options.name,
    tags: options.tags,
  })
}

function omitUndefined(values: Record<string, unknown>): JsonObject {
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

function toDatasetError(error: unknown, isCaseEndpoint: boolean): Error {
  if (error instanceof PlatformHTTPError) {
    if (error.status === 404) {
      if (isCaseEndpoint && isCaseNotFoundDetail(error.detail)) {
        return new CaseNotFoundError(error.detail)
      }
      return new DatasetNotFoundError(error.detail)
    }
    return new DatasetApiError(error.status, error.detail)
  }
  if (error instanceof PlatformConfigurationError) {
    return new DatasetConfigurationError(error.message)
  }
  if (error instanceof PlatformTimeoutError) {
    return new DatasetTimeoutError(error.message)
  }
  if (error instanceof PlatformTransportError) {
    return new DatasetTransportError(error.message)
  }
  return new DatasetTransportError(formatDetail(error))
}

function isCaseNotFoundDetail(detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null || !('detail' in detail)) {
    return false
  }
  const message = (detail as { detail?: unknown }).detail
  return typeof message === 'string' && message.toLowerCase().includes('case')
}

function normalizeBaseUrlOption(baseUrl: string | undefined): string | undefined {
  return baseUrl === undefined || baseUrl.trim() === '' ? undefined : baseUrl
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}
