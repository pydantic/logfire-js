import { context as ContextAPI, createContextKey, propagation, trace as TraceAPI } from '@opentelemetry/api'

import { murmurhash3x64128 } from '../murmurhash'
import { startSpan } from '../index'

export type JsonSchema = Record<string, unknown>

export type ResolveFunction<T> = (targetingKey: string | undefined, attributes: Record<string, unknown>) => Promise<T> | T

export interface VariableCodec<T> {
  jsonSchema?: JsonSchema
  parse(value: unknown): T
  serialize?: (value: T) => string
  typeName?: string
}

export interface VariableOptions<T> {
  codec?: VariableCodec<T>
  default: ResolveFunction<T> | T
  description?: string
}

export interface VariableDefinition {
  codec: Pick<VariableCodec<unknown>, 'parse'>
  description: string | undefined
  name: string
  toConfig(): VariableConfig
}

export interface VariableNameLike {
  name: string
}

export interface VariableGetOptions {
  attributes?: Record<string, unknown>
  label?: string
  targetingKey?: string
}

export interface ResolvedVariableInit<T> {
  exception?: unknown
  label?: string
  name: string
  reason: VariableResolutionReason
  value: T
  version?: number
}

export type VariableResolutionReason =
  | 'context_override'
  | 'missing_config'
  | 'no_provider'
  | 'other_error'
  | 'resolved'
  | 'unrecognized_variable'
  | 'validation_error'

export class ResolvedVariable<T> {
  exception: unknown
  label: string | undefined
  name: string
  reason: VariableResolutionReason
  value: T
  version: number | undefined

  constructor(init: ResolvedVariableInit<T>) {
    this.exception = init.exception
    this.label = init.label
    this.name = init.name
    this.reason = init.reason
    this.value = init.value
    this.version = init.version
  }

  async withContext<R>(callback: () => Promise<R> | R): Promise<R> {
    const active = ContextAPI.active()
    const baggage = propagation.getBaggage(active) ?? propagation.createBaggage()
    const nextBaggage = baggage.setEntry(`logfire.variables.${this.name}`, { value: this.label ?? '<code_default>' })
    return ContextAPI.with(propagation.setBaggage(active, nextBaggage), callback)
  }
}

export interface SerializedResolvedVariableInit {
  label?: string
  name: string
  reason: VariableResolutionReason
  value: string | undefined
  version?: number
}

export class SerializedResolvedVariable extends ResolvedVariable<string | undefined> {}

export interface LabeledValue {
  serialized_value: string
  version: number
}

export interface LabelRef {
  ref: string
  version?: number | null
}

export interface LatestVersion {
  serialized_value: string
  version: number
}

export interface Rollout {
  labels: Record<string, number>
}

export type Condition =
  | KeyIsNotPresent
  | KeyIsPresent
  | ValueDoesNotEqual
  | ValueDoesNotMatchRegex
  | ValueEquals
  | ValueIsIn
  | ValueIsNotIn
  | ValueMatchesRegex

export interface ValueEquals {
  attribute: string
  kind: 'value-equals'
  value: unknown
}

export interface ValueDoesNotEqual {
  attribute: string
  kind: 'value-does-not-equal'
  value: unknown
}

export interface ValueIsIn {
  attribute: string
  kind: 'value-is-in'
  values: unknown[]
}

export interface ValueIsNotIn {
  attribute: string
  kind: 'value-is-not-in'
  values: unknown[]
}

export interface ValueMatchesRegex {
  attribute: string
  kind: 'value-matches-regex'
  pattern: string
}

export interface ValueDoesNotMatchRegex {
  attribute: string
  kind: 'value-does-not-match-regex'
  pattern: string
}

export interface KeyIsPresent {
  attribute: string
  kind: 'key-is-present'
}

export interface KeyIsNotPresent {
  attribute: string
  kind: 'key-is-not-present'
}

export interface RolloutOverride {
  conditions: Condition[]
  rollout: Rollout
}

export interface VariableConfig {
  aliases?: string[] | null
  description?: string | null
  example?: string | null
  json_schema?: JsonSchema | null
  labels: Record<string, LabelRef | LabeledValue>
  latest_version?: LatestVersion | null
  name: string
  overrides: RolloutOverride[]
  rollout: Rollout
  type_name?: string | null
}

export interface VariablesConfig {
  variables: Record<string, VariableConfig>
}

export interface VariableTypeConfig {
  description?: string | null
  json_schema: JsonSchema
  name: string
  source_hint?: string | null
}

export interface LabelValidationError {
  error: unknown
  label: string | undefined
  variableName: string
}

export interface DescriptionDifference {
  localDescription: string | undefined
  serverDescription: string | undefined
  variableName: string
}

export interface ValidationReport {
  descriptionDifferences: DescriptionDifference[]
  errors: LabelValidationError[]
  isValid: boolean
  variablesChecked: number
  variablesNotOnServer: string[]
}

export type MaybePromise<T> = T | Promise<T>

export interface VariableProvider {
  batchUpdate?(updates: Record<string, VariableConfig | undefined>): MaybePromise<void>
  createVariable?(config: VariableConfig): MaybePromise<VariableConfig>
  deleteVariable?(name: string): MaybePromise<void>
  getAllVariablesConfig?(): MaybePromise<VariablesConfig>
  getSerializedValue(
    variableName: string,
    targetingKey?: string,
    attributes?: Record<string, unknown>
  ): MaybePromise<SerializedResolvedVariable>
  getSerializedValueForLabel?(variableName: string, label: string): MaybePromise<SerializedResolvedVariable>
  getVariableConfig?(name: string): MaybePromise<VariableConfig | undefined>
  listVariableTypes?(): MaybePromise<Record<string, VariableTypeConfig>>
  refresh?(force?: boolean): MaybePromise<void>
  shutdown?(): MaybePromise<void>
  start?(): void
  updateVariable?(name: string, config: VariableConfig): MaybePromise<VariableConfig>
  upsertVariableType?(config: VariableTypeConfig): MaybePromise<VariableTypeConfig>
}

export interface VariablesOptions {
  apiKey?: string
  baseUrl?: string
  blockBeforeFirstResolve?: boolean
  fetch?: typeof fetch
  includeBaggageInContext?: boolean
  includeResourceAttributesInContext?: boolean
  instrument?: boolean
  polling?: boolean
  pollingInterval?: number
  sse?: boolean
  timeoutMs?: number
}

export interface LocalVariablesOptions {
  config: VariablesConfig
  includeBaggageInContext?: boolean
  includeResourceAttributesInContext?: boolean
  instrument?: boolean
}

export type VariablesConfigOptions = false | LocalVariablesOptions | VariablesOptions | undefined

export interface ConfigureVariablesRuntimeOptions {
  apiKey?: string
  baseUrl?: string
  resourceAttributes?: Record<string, unknown>
}

export interface VariablePushResult {
  changes: VariablePushChange[]
  dryRun: boolean
}

export interface VariablePushChange {
  action: 'create' | 'delete' | 'update'
  name: string
}

export class VariableWriteError extends Error {
  override name: string = 'VariableWriteError'
}

export class VariableNotFoundError extends VariableWriteError {
  override name: string = 'VariableNotFoundError'
}

export class VariableAlreadyExistsError extends VariableWriteError {
  override name: string = 'VariableAlreadyExistsError'
}

export class NoOpVariableProvider implements VariableProvider {
  getSerializedValue(variableName: string): SerializedResolvedVariable {
    return new SerializedResolvedVariable({ name: variableName, reason: 'no_provider', value: undefined })
  }

  getVariableConfig(): VariableConfig | undefined {
    return undefined
  }

  getAllVariablesConfig(): VariablesConfig {
    return { variables: {} }
  }
}

export class LocalVariableProvider implements VariableProvider {
  private config: VariablesConfig

  constructor(config: VariablesConfig) {
    this.config = normalizeVariablesConfig(config)
  }

  getSerializedValue(variableName: string, targetingKey?: string, attributes?: Record<string, unknown>): SerializedResolvedVariable {
    return resolveSerializedValue(this.config, variableName, targetingKey, attributes)
  }

  getSerializedValueForLabel(variableName: string, label: string): SerializedResolvedVariable {
    return resolveSerializedValueForLabel(this.config, variableName, label)
  }

  getVariableConfig(name: string): VariableConfig | undefined {
    return getVariableConfig(this.config, name)
  }

  getAllVariablesConfig(): VariablesConfig {
    return this.config
  }

  createVariable(config: VariableConfig): VariableConfig {
    const normalized = normalizeVariableConfig(config)
    if (Object.hasOwn(this.config.variables, normalized.name)) {
      throw new VariableAlreadyExistsError(`Variable '${normalized.name}' already exists`)
    }
    this.config = { variables: { ...this.config.variables, [normalized.name]: normalized } }
    return normalized
  }

  updateVariable(name: string, config: VariableConfig): VariableConfig {
    if (!Object.hasOwn(this.config.variables, name)) {
      throw new VariableNotFoundError(`Variable '${name}' not found`)
    }
    const normalized = normalizeVariableConfig(config)
    const variables = withoutKey(this.config.variables, name)
    variables[normalized.name] = normalized
    this.config = { variables }
    return normalized
  }

  deleteVariable(name: string): void {
    if (!Object.hasOwn(this.config.variables, name)) {
      throw new VariableNotFoundError(`Variable '${name}' not found`)
    }
    const variables = withoutKey(this.config.variables, name)
    this.config = { variables }
  }

  batchUpdate(updates: Record<string, VariableConfig | undefined>): void {
    let variables = { ...this.config.variables }
    for (const [name, config] of Object.entries(updates)) {
      if (config === undefined) {
        variables = withoutKey(variables, name)
      } else {
        const normalized = normalizeVariableConfig(config)
        variables = withoutKey(variables, name)
        variables[normalized.name] = normalized
      }
    }
    this.config = { variables }
  }
}

export interface RemoteVariableProviderOptions extends VariablesOptions {
  apiKey: string
  baseUrl: string
}

export class LogfireRemoteVariableProvider implements VariableProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly blockBeforeFirstResolve: boolean
  private readonly fetchImpl: typeof fetch
  private readonly pollingEnabled: boolean
  private readonly pollingIntervalMs: number
  private readonly sseEnabled: boolean
  private readonly timeoutMs: number

  private config: VariablesConfig | undefined
  private hasAttemptedFetch: boolean = false
  private lastFetchedAt: number | undefined
  private pollingTimer: ReturnType<typeof setInterval> | undefined
  private queuedForcedRefreshPromise: Promise<void> | undefined
  private refreshPromise: Promise<void> | undefined
  private sseController: AbortController | undefined
  private shutdownRequested: boolean = false
  private started: boolean = false

  constructor(options: RemoteVariableProviderOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = trimTrailingSlash(options.baseUrl)
    this.blockBeforeFirstResolve = options.blockBeforeFirstResolve ?? true
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.pollingEnabled = options.polling ?? true
    this.pollingIntervalMs = Math.max(options.pollingInterval ?? 60, 10) * 1000
    this.sseEnabled = options.sse ?? true
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Managed variables require a fetch implementation')
    }
  }

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    if (this.pollingEnabled) {
      this.pollingTimer = setInterval(() => {
        this.refresh().catch(ignoreBackgroundError)
      }, this.pollingIntervalMs)
      const maybeTimer = this.pollingTimer as { unref?: () => void }
      if (typeof maybeTimer.unref === 'function') {
        maybeTimer.unref()
      }
    }
    if (this.sseEnabled) {
      this.runSseLoop().catch(ignoreBackgroundError)
    }
  }

  shutdown(): void {
    this.shutdownRequested = true
    this.sseController?.abort()
    this.sseController = undefined
    if (this.pollingTimer !== undefined) {
      clearInterval(this.pollingTimer)
      this.pollingTimer = undefined
    }
  }

  async refresh(force: boolean = false): Promise<void> {
    if (this.refreshPromise !== undefined) {
      if (!force) {
        return this.refreshPromise
      }
      this.queuedForcedRefreshPromise ??= this.refreshPromise.catch(ignoreBackgroundError).then(async () => {
        await this.runQueuedForcedRefresh()
      })
      return this.queuedForcedRefreshPromise
    }

    const now = Date.now()
    if (!force && this.lastFetchedAt !== undefined && now - this.lastFetchedAt < this.pollingIntervalMs) {
      return
    }

    this.refreshPromise = this.fetchJson(`${this.baseUrl}/v1/variables/`, { method: 'GET' })
      .then((data) => {
        this.config = normalizeVariablesConfig(data)
        this.lastFetchedAt = Date.now()
      })
      .finally(() => {
        this.hasAttemptedFetch = true
        this.refreshPromise = undefined
      })
    return this.refreshPromise
  }

  private async runQueuedForcedRefresh(): Promise<void> {
    this.queuedForcedRefreshPromise = undefined
    await this.refresh(true)
  }

  async getSerializedValue(
    variableName: string,
    targetingKey?: string,
    attributes?: Record<string, unknown>
  ): Promise<SerializedResolvedVariable> {
    this.start()
    if (!this.hasAttemptedFetch && this.blockBeforeFirstResolve) {
      try {
        await this.refresh()
      } catch {
        // The caller should get the default rather than a failed variable lookup.
      }
    } else if (!this.hasAttemptedFetch) {
      this.refresh().catch(ignoreBackgroundError)
    }

    if (this.config === undefined) {
      return new SerializedResolvedVariable({ name: variableName, reason: 'missing_config', value: undefined })
    }
    return resolveSerializedValue(this.config, variableName, targetingKey, attributes)
  }

  async getSerializedValueForLabel(variableName: string, label: string): Promise<SerializedResolvedVariable> {
    this.start()
    if (!this.hasAttemptedFetch && this.blockBeforeFirstResolve) {
      try {
        await this.refresh()
      } catch {
        // The caller should get the default rather than a failed variable lookup.
      }
    }
    if (this.config === undefined) {
      return new SerializedResolvedVariable({ name: variableName, reason: 'missing_config', value: undefined })
    }
    return resolveSerializedValueForLabel(this.config, variableName, label)
  }

  getVariableConfig(name: string): VariableConfig | undefined {
    if (this.config === undefined) {
      return undefined
    }
    return getVariableConfig(this.config, name)
  }

  async getAllVariablesConfig(): Promise<VariablesConfig> {
    await this.refresh(true)
    return this.config ?? { variables: {} }
  }

  async createVariable(config: VariableConfig): Promise<VariableConfig> {
    const normalized = normalizeVariableConfig(config)
    try {
      await this.fetchJson(`${this.baseUrl}/v1/variables/`, {
        body: JSON.stringify(configToApiBody(normalized)),
        method: 'POST',
      })
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 409) {
        throw new VariableAlreadyExistsError(`Variable '${normalized.name}' already exists`)
      }
      throw toVariableWriteError('Failed to create variable', error)
    }
    await this.refresh(true)
    return normalized
  }

  async updateVariable(name: string, config: VariableConfig): Promise<VariableConfig> {
    const normalized = normalizeVariableConfig(config)
    try {
      await this.fetchJson(`${this.baseUrl}/v1/variables/${encodeURIComponent(name)}/`, {
        body: JSON.stringify(configToApiBody(normalized)),
        method: 'PUT',
      })
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) {
        throw new VariableNotFoundError(`Variable '${name}' not found`)
      }
      throw toVariableWriteError('Failed to update variable', error)
    }
    await this.refresh(true)
    return normalized
  }

  async deleteVariable(name: string): Promise<void> {
    try {
      await this.fetchJson(`${this.baseUrl}/v1/variables/${encodeURIComponent(name)}/`, { method: 'DELETE' })
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) {
        throw new VariableNotFoundError(`Variable '${name}' not found`)
      }
      throw toVariableWriteError('Failed to delete variable', error)
    }
    await this.refresh(true)
  }

  async batchUpdate(updates: Record<string, VariableConfig | undefined>): Promise<void> {
    const current = await this.getAllVariablesConfig()
    await Promise.all(
      Object.entries(updates).map(async ([name, config]) => {
        if (config === undefined) {
          await this.deleteVariable(name)
          return
        }
        if (getVariableConfig(current, name) === undefined) {
          await this.createVariable(config)
          return
        }
        await this.updateVariable(name, config)
      })
    )
  }

  async listVariableTypes(): Promise<Record<string, VariableTypeConfig>> {
    const data = await this.fetchJson(`${this.baseUrl}/v1/variable-types/`, { method: 'GET' })
    if (!Array.isArray(data)) {
      throw new VariableWriteError('Failed to list variable types: expected an array response')
    }
    const result: Record<string, VariableTypeConfig> = {}
    for (const item of data) {
      const typeConfig = normalizeVariableTypeConfig(item)
      result[typeConfig.name] = typeConfig
    }
    return result
  }

  async upsertVariableType(config: VariableTypeConfig): Promise<VariableTypeConfig> {
    const normalized = normalizeVariableTypeConfig(config)
    try {
      await this.fetchJson(`${this.baseUrl}/v1/variable-types/`, {
        body: JSON.stringify(normalized),
        method: 'POST',
      })
    } catch (error) {
      throw toVariableWriteError('Failed to upsert variable type', error)
    }
    return normalized
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      const headers = new Headers(init.headers)
      headers.set('Accept', 'application/json')
      headers.set('Authorization', `bearer ${this.apiKey}`)
      headers.set('Content-Type', 'application/json')
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new HttpStatusError(response.status, response.statusText)
      }
      if (response.status === 204) {
        return null
      }
      return await response.json()
    } finally {
      clearTimeout(timeout)
    }
  }

  private async runSseLoop(): Promise<void> {
    let reconnectDelay = 1_000
    while (!this.shutdownRequested) {
      try {
        const controller = new AbortController()
        this.sseController = controller
        // eslint-disable-next-line no-await-in-loop -- SSE reconnects must wait for the current connection attempt.
        const response = await this.fetchImpl(`${this.baseUrl}/v1/variable-updates/`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `bearer ${this.apiKey}`,
            'Cache-Control': 'no-cache',
          },
          method: 'GET',
          signal: controller.signal,
        })
        if (!response.ok || response.body === null) {
          throw new HttpStatusError(response.status, response.statusText)
        }
        reconnectDelay = 1_000
        // eslint-disable-next-line no-await-in-loop -- the stream must be consumed before reconnecting.
        await this.readSseStream(response.body)
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- shutdown can be requested while fetch/read is pending.
        if (this.shutdownRequested) {
          break
        }
        // eslint-disable-next-line no-await-in-loop -- reconnect backoff is inherently sequential.
        await delay(reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      } finally {
        this.sseController = undefined
      }
    }
  }

  private async readSseStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!this.shutdownRequested) {
        // eslint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially.
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) {
            continue
          }
          const json = trimmed.slice(5).trim()
          try {
            const event = JSON.parse(json) as { event?: string }
            if (event.event === 'created' || event.event === 'updated' || event.event === 'deleted') {
              this.refresh(true).catch(ignoreBackgroundError)
            }
          } catch {
            // Ignore malformed SSE data.
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

class HttpStatusError extends Error {
  status: number

  constructor(status: number, statusText: string) {
    super(`HTTP ${status.toString()}: ${statusText}`)
    this.status = status
  }
}

export class Variable<T> {
  codec: VariableCodec<T>
  defaultValue: ResolveFunction<T> | T
  description: string | undefined
  name: string

  constructor(name: string, options: VariableOptions<T>) {
    validateVariableName(name)
    this.name = name
    this.description = options.description
    this.defaultValue = options.default
    this.codec = options.codec ?? inferCodec(options.default)
  }

  async get(options: VariableGetOptions = {}): Promise<ResolvedVariable<T>> {
    const attributes = getMergedAttributes(options.attributes)
    const targetingKey = options.targetingKey ?? getContextTargetingKey(this.name) ?? getActiveTraceTargetingKey()
    if (shouldInstrumentVariables()) {
      return this.getWithSpan(targetingKey, attributes, options.label)
    }
    return this.resolve(targetingKey, attributes, options.label)
  }

  async refresh(force: boolean = false): Promise<void> {
    await getVariableProvider().refresh?.(force)
  }

  async override<R>(value: ResolveFunction<T> | T, callback: () => Promise<R> | R): Promise<R> {
    const current = getOverrideContext()
    const next = { ...current, [this.name]: value }
    return withOverrideContext(next, callback)
  }

  toConfig(): VariableConfig {
    return variableToConfig(this)
  }

  private async getWithSpan(
    targetingKey: string | undefined,
    attributes: Record<string, unknown>,
    label: string | undefined
  ): Promise<ResolvedVariable<T>> {
    const span = startSpan(`Resolve variable ${this.name}`, {
      attributes,
      name: this.name,
      targeting_key: targetingKey,
    })
    try {
      const result = await this.resolve(targetingKey, attributes, label)
      span.setAttribute('name', result.name)
      span.setAttribute('reason', result.reason)
      if (result.label !== undefined) {
        span.setAttribute('label', result.label)
      }
      if (result.version !== undefined) {
        span.setAttribute('version', result.version)
      }
      try {
        span.setAttribute('value', serializeWithCodec(this.codec, result.value))
      } catch {
        span.setAttribute('value', formatUnknown(result.value))
      }
      if (result.exception !== undefined) {
        span.recordException(result.exception instanceof Error ? result.exception : formatUnknown(result.exception))
      }
      return result
    } finally {
      span.end()
    }
  }

  private async resolve(
    targetingKey: string | undefined,
    attributes: Record<string, unknown>,
    label: string | undefined
  ): Promise<ResolvedVariable<T>> {
    try {
      const overrides = getOverrideContext()
      if (Object.hasOwn(overrides, this.name)) {
        const overrideValue = overrides[this.name] as ResolveFunction<T> | T
        return new ResolvedVariable({
          name: this.name,
          reason: 'context_override',
          value: await resolveMaybeFunction(overrideValue, targetingKey, attributes),
        })
      }

      const provider = getVariableProvider()
      let serialized =
        label === undefined
          ? await provider.getSerializedValue(this.name, targetingKey, attributes)
          : await getSerializedValueForLabel(provider, this.name, label)

      if (label !== undefined && serialized.value === undefined && serialized.label === undefined) {
        serialized = await provider.getSerializedValue(this.name, targetingKey, attributes)
      }

      if (serialized.value === undefined) {
        return await resolvedWithDefault(this, serialized, targetingKey, attributes)
      }

      try {
        const parsed = this.codec.parse(JSON.parse(serialized.value))
        const init: ResolvedVariableInit<T> = {
          name: serialized.name,
          reason: 'resolved',
          value: parsed,
        }
        if (serialized.label !== undefined) {
          init.label = serialized.label
        }
        if (serialized.version !== undefined) {
          init.version = serialized.version
        }
        return new ResolvedVariable(init)
      } catch (error) {
        return new ResolvedVariable({
          exception: error,
          name: this.name,
          reason: isSyntaxOrValidationError(error) ? 'validation_error' : 'other_error',
          value: await resolveMaybeFunction(this.defaultValue, targetingKey, attributes),
        })
      }
    } catch (error) {
      return new ResolvedVariable({
        exception: error,
        name: this.name,
        reason: 'other_error',
        value: await resolveMaybeFunction(this.defaultValue, targetingKey, attributes),
      })
    }
  }
}

const registeredVariables = new Map<string, VariableDefinition>()

interface VariableRuntimeState {
  apiKey: string | undefined
  baseUrl: string | undefined
  explicitProviderConfigured: boolean
  includeBaggageInContext: boolean
  includeResourceAttributesInContext: boolean
  instrument: boolean
  provider: VariableProvider
  remoteOptions: VariablesOptions | undefined
  resourceAttributes: Record<string, unknown>
}

const runtimeState: VariableRuntimeState = {
  apiKey: undefined,
  baseUrl: undefined,
  explicitProviderConfigured: false,
  includeBaggageInContext: true,
  includeResourceAttributesInContext: true,
  instrument: true,
  provider: new NoOpVariableProvider(),
  remoteOptions: undefined,
  resourceAttributes: {},
}

export function defineVar<T>(name: string, options: VariableOptions<T>): Variable<T> {
  if (registeredVariables.has(name)) {
    throw new Error(`A variable with name '${name}' has already been registered`)
  }
  const variable = new Variable(name, options)
  registeredVariables.set(name, variable)
  return variable
}

export { defineVar as var }

export function variablesClear(): void {
  registeredVariables.clear()
}

export function variablesGet(): VariableDefinition[] {
  return [...registeredVariables.values()]
}

export function variablesBuildConfig(variables: VariableDefinition[] = variablesGet()): VariablesConfig {
  const configs: Record<string, VariableConfig> = {}
  for (const variable of variables) {
    configs[variable.name] = variable.toConfig()
  }
  return { variables: configs }
}

export async function variablesValidate(variables: VariableDefinition[] = variablesGet()): Promise<ValidationReport> {
  const provider = getVariableProvider()
  await provider.refresh?.(true)
  const config = (await provider.getAllVariablesConfig?.()) ?? { variables: {} }
  return validateVariablesAgainstConfig(variables, config)
}

export async function variablesPush(
  variables: VariableDefinition[] = variablesGet(),
  options: { dryRun?: boolean; strict?: boolean } = {}
): Promise<VariablePushResult> {
  const provider = getWritableProvider()
  await provider.refresh?.(true)
  const serverConfig = (await provider.getAllVariablesConfig?.()) ?? { variables: {} }
  const report = validateVariablesAgainstConfig(variables, serverConfig)
  if (options.strict === true && !report.isValid) {
    throw new VariableWriteError('Cannot push variables: provider values are incompatible with local variable codecs')
  }

  const updates: Record<string, VariableConfig> = {}
  const changes: VariablePushChange[] = []
  for (const variable of variables) {
    const local = variable.toConfig()
    const existing = getVariableConfig(serverConfig, variable.name)
    if (existing === undefined) {
      updates[local.name] = local
      changes.push({ action: 'create', name: local.name })
      continue
    }
    const merged = {
      ...existing,
      description: local.description ?? null,
      example: local.example ?? null,
      json_schema: local.json_schema ?? null,
      type_name: local.type_name ?? null,
    }
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      updates[existing.name] = merged
      changes.push({ action: 'update', name: existing.name })
    }
  }

  if (options.dryRun !== true && Object.keys(updates).length > 0) {
    await provider.batchUpdate(updates)
  }
  return { changes, dryRun: options.dryRun === true }
}

export async function variablesPushConfig(
  config: VariablesConfig,
  options: { dryRun?: boolean; mode?: 'merge' | 'replace' } = {}
): Promise<VariablePushResult> {
  const normalized = normalizeVariablesConfig(config)
  const provider = getWritableProvider()
  await provider.refresh?.(true)
  const serverConfig = (await provider.getAllVariablesConfig?.()) ?? { variables: {} }
  const updates: Record<string, VariableConfig | undefined> = {}
  const changes: VariablePushChange[] = []

  for (const [name, variableConfig] of Object.entries(normalized.variables)) {
    const existing = getVariableConfig(serverConfig, name)
    updates[name] = variableConfig
    changes.push({ action: existing === undefined ? 'create' : 'update', name })
  }

  if (options.mode === 'replace') {
    for (const name of Object.keys(serverConfig.variables)) {
      if (!Object.hasOwn(normalized.variables, name)) {
        updates[name] = undefined
        changes.push({ action: 'delete', name })
      }
    }
  }

  if (options.dryRun !== true && Object.keys(updates).length > 0) {
    await provider.batchUpdate(updates)
  }
  return { changes, dryRun: options.dryRun === true }
}

export async function variablesPullConfig(): Promise<VariablesConfig> {
  const provider = getVariableProvider()
  await provider.refresh?.(true)
  return (await provider.getAllVariablesConfig?.()) ?? { variables: {} }
}

export async function variablesPushTypes(types: VariableTypeConfig[], options: { dryRun?: boolean } = {}): Promise<VariablePushResult> {
  const provider = getWritableProvider()
  if (typeof provider.listVariableTypes !== 'function' || typeof provider.upsertVariableType !== 'function') {
    throw new VariableWriteError('Configured variable provider does not support variable types')
  }
  const changes: VariablePushChange[] = []
  const existing = await provider.listVariableTypes()
  const upserts: Promise<VariableTypeConfig>[] = []
  for (const typeConfig of types) {
    const normalized = normalizeVariableTypeConfig(typeConfig)
    changes.push({ action: Object.hasOwn(existing, normalized.name) ? 'update' : 'create', name: normalized.name })
    if (options.dryRun !== true) {
      upserts.push(Promise.resolve(provider.upsertVariableType(normalized)))
    }
  }
  await Promise.all(upserts)
  return { changes, dryRun: options.dryRun === true }
}

export function configureVariables(options?: VariablesConfigOptions, runtime: ConfigureVariablesRuntimeOptions = {}): void {
  const oldProvider = runtimeState.provider
  runtimeState.apiKey = runtime.apiKey
  runtimeState.baseUrl = runtime.baseUrl
  runtimeState.resourceAttributes = runtime.resourceAttributes ?? {}

  if (options === false) {
    runtimeState.explicitProviderConfigured = true
    runtimeState.provider = new NoOpVariableProvider()
    runtimeState.remoteOptions = undefined
    shutdownProvider(oldProvider)
    return
  }

  if (isLocalVariablesOptions(options)) {
    runtimeState.explicitProviderConfigured = true
    runtimeState.includeBaggageInContext = options.includeBaggageInContext ?? true
    runtimeState.includeResourceAttributesInContext = options.includeResourceAttributesInContext ?? true
    runtimeState.instrument = options.instrument ?? true
    runtimeState.provider = new LocalVariableProvider(options.config)
    runtimeState.remoteOptions = undefined
    shutdownProvider(oldProvider)
    return
  }

  const remoteOptions = options ?? undefined
  runtimeState.explicitProviderConfigured = remoteOptions !== undefined
  runtimeState.includeBaggageInContext = remoteOptions?.includeBaggageInContext ?? true
  runtimeState.includeResourceAttributesInContext = remoteOptions?.includeResourceAttributesInContext ?? true
  runtimeState.instrument = remoteOptions?.instrument ?? true
  runtimeState.remoteOptions = remoteOptions

  if (remoteOptions !== undefined) {
    const apiKey = remoteOptions.apiKey ?? runtime.apiKey
    if (apiKey === undefined || apiKey === '') {
      throw new Error('Remote variables require an API key. Set LOGFIRE_API_KEY or pass apiKey to configure().')
    }
    runtimeState.provider = new LogfireRemoteVariableProvider({
      ...remoteOptions,
      apiKey,
      baseUrl: remoteOptions.baseUrl ?? runtime.baseUrl ?? 'https://logfire-us.pydantic.dev',
    })
    runtimeState.provider.start?.()
    shutdownProvider(oldProvider)
    return
  }

  runtimeState.provider = new NoOpVariableProvider()
  shutdownProvider(oldProvider)
}

export async function shutdownVariables(): Promise<void> {
  await runtimeState.provider.shutdown?.()
  runtimeState.apiKey = undefined
  runtimeState.baseUrl = undefined
  runtimeState.explicitProviderConfigured = false
  runtimeState.includeBaggageInContext = true
  runtimeState.includeResourceAttributesInContext = true
  runtimeState.instrument = true
  runtimeState.provider = new NoOpVariableProvider()
  runtimeState.remoteOptions = undefined
  runtimeState.resourceAttributes = {}
}

export function getVariableProvider(): VariableProvider {
  if (runtimeState.provider instanceof NoOpVariableProvider && !runtimeState.explicitProviderConfigured) {
    const apiKey = runtimeState.apiKey
    if (apiKey !== undefined && apiKey !== '') {
      runtimeState.provider = new LogfireRemoteVariableProvider({
        ...(runtimeState.remoteOptions ?? {}),
        apiKey,
        baseUrl: runtimeState.baseUrl ?? runtimeState.remoteOptions?.baseUrl ?? 'https://logfire-us.pydantic.dev',
      })
      runtimeState.provider.start?.()
    }
  }
  return runtimeState.provider
}

export async function targetingContext<R>(
  targetingKey: string,
  callbackOrOptions: (() => Promise<R> | R) | { variables?: VariableNameLike[] },
  maybeCallback?: () => Promise<R> | R
): Promise<R> {
  const callback = typeof callbackOrOptions === 'function' ? callbackOrOptions : maybeCallback
  if (callback === undefined) {
    throw new Error('targetingContext requires a callback')
  }
  const variables = typeof callbackOrOptions === 'function' ? undefined : callbackOrOptions.variables
  const current = getTargetingContext()
  const next: TargetingContextData = {
    byVariable: { ...current.byVariable },
    defaultKey: current.defaultKey,
  }
  if (variables === undefined) {
    next.defaultKey = targetingKey
  } else {
    for (const variable of variables) {
      next.byVariable[variable.name] = targetingKey
    }
  }
  return withTargetingContext(next, callback)
}

function validateVariablesAgainstConfig(variables: VariableDefinition[], config: VariablesConfig): ValidationReport {
  const errors: LabelValidationError[] = []
  const variablesNotOnServer: string[] = []
  const descriptionDifferences: DescriptionDifference[] = []
  for (const variable of variables) {
    const serverVariable = getVariableConfig(config, variable.name)
    if (serverVariable === undefined) {
      variablesNotOnServer.push(variable.name)
      continue
    }
    const serverDescription = normalizeDescriptionForComparison(serverVariable.description)
    const localDescription = normalizeDescriptionForComparison(variable.description)
    if (serverDescription !== localDescription) {
      descriptionDifferences.push({
        localDescription,
        serverDescription,
        variableName: variable.name,
      })
    }
    for (const [label, labeled] of Object.entries(serverVariable.labels)) {
      if (!isLabeledValue(labeled)) {
        continue
      }
      try {
        variable.codec.parse(JSON.parse(labeled.serialized_value))
      } catch (error) {
        errors.push({ error, label, variableName: variable.name })
      }
    }
    if (serverVariable.latest_version !== null && serverVariable.latest_version !== undefined) {
      try {
        variable.codec.parse(JSON.parse(serverVariable.latest_version.serialized_value))
      } catch (error) {
        errors.push({ error, label: 'latest', variableName: variable.name })
      }
    }
  }
  return {
    descriptionDifferences,
    errors,
    isValid: errors.length === 0 && variablesNotOnServer.length === 0,
    variablesChecked: variables.length,
    variablesNotOnServer,
  }
}

function getWritableProvider(): Required<Pick<VariableProvider, 'batchUpdate'>> & VariableProvider {
  const provider = getVariableProvider()
  if (typeof provider.batchUpdate !== 'function') {
    throw new VariableWriteError('No writable variable provider configured')
  }
  return provider as Required<Pick<VariableProvider, 'batchUpdate'>> & VariableProvider
}

async function getSerializedValueForLabel(
  provider: VariableProvider,
  variableName: string,
  label: string
): Promise<SerializedResolvedVariable> {
  if (typeof provider.getSerializedValueForLabel === 'function') {
    return provider.getSerializedValueForLabel(variableName, label)
  }
  const config = await provider.getVariableConfig?.(variableName)
  if (config === undefined) {
    return new SerializedResolvedVariable({ name: variableName, reason: 'unrecognized_variable', value: undefined })
  }
  return resolveVariableConfigForLabel(config, label)
}

async function resolvedWithDefault<T>(
  variable: Variable<T>,
  serialized: SerializedResolvedVariable,
  targetingKey: string | undefined,
  attributes: Record<string, unknown>
): Promise<ResolvedVariable<T>> {
  const init: ResolvedVariableInit<T> = {
    name: serialized.name,
    reason: serialized.reason,
    value: await resolveMaybeFunction(variable.defaultValue, targetingKey, attributes),
  }
  if (serialized.exception !== undefined) {
    init.exception = serialized.exception
  }
  if (serialized.label !== undefined) {
    init.label = serialized.label
  }
  if (serialized.version !== undefined) {
    init.version = serialized.version
  }
  return new ResolvedVariable(init)
}

async function resolveMaybeFunction<T>(
  value: ResolveFunction<T> | T,
  targetingKey: string | undefined,
  attributes: Record<string, unknown>
): Promise<T> {
  if (typeof value === 'function') {
    return (value as ResolveFunction<T>)(targetingKey, attributes)
  }
  return value
}

function inferCodec<T>(defaultValue: ResolveFunction<T> | T): VariableCodec<T> {
  if (typeof defaultValue === 'function') {
    throw new TypeError('Variables with function defaults require an explicit codec')
  }
  const schema = inferJsonSchema(defaultValue)
  return {
    jsonSchema: schema,
    parse(value: unknown): T {
      const schemaType = schema['type']
      if (schemaType === undefined) {
        return value as T
      }
      if (schemaType === 'array') {
        if (!Array.isArray(value)) {
          throw new TypeError('Expected array')
        }
        return value as T
      }
      if (schemaType === 'null') {
        if (value !== null) {
          throw new TypeError('Expected null')
        }
        return value as T
      }
      if (schemaType === 'boolean') {
        if (typeof value !== 'boolean') {
          throw new TypeError('Expected boolean')
        }
        return value as T
      }
      if (schemaType === 'number') {
        if (typeof value !== 'number') {
          throw new TypeError('Expected number')
        }
        return value as T
      }
      if (schemaType === 'string') {
        if (typeof value !== 'string') {
          throw new TypeError('Expected string')
        }
        return value as T
      }
      throw new TypeError(`Expected ${formatUnknown(schemaType)}`)
    },
  }
}

function inferJsonSchema(value: unknown): JsonSchema {
  if (value === null) {
    return { type: 'null' }
  }
  if (Array.isArray(value)) {
    return { type: 'array' }
  }
  const type = typeof value
  if (type === 'boolean' || type === 'number' || type === 'string') {
    return { type }
  }
  if (type === 'object') {
    return { type: 'object' }
  }
  return {}
}

function serializeWithCodec<T>(codec: VariableCodec<T>, value: T): string {
  return codec.serialize?.(value) ?? JSON.stringify(value)
}

function variableToConfig<T>(variable: Variable<T>): VariableConfig {
  const isFunctionDefault = typeof variable.defaultValue === 'function'
  return {
    description: variable.description ?? null,
    example: isFunctionDefault ? null : serializeWithCodec(variable.codec, variable.defaultValue as T),
    json_schema: variable.codec.jsonSchema ?? null,
    labels: {},
    name: variable.name,
    overrides: [],
    rollout: { labels: {} },
    type_name: variable.codec.typeName ?? null,
  }
}

function resolveSerializedValue(
  config: VariablesConfig,
  name: string,
  targetingKey?: string,
  attributes?: Record<string, unknown>
): SerializedResolvedVariable {
  const variableConfig = getVariableConfig(config, name)
  if (variableConfig === undefined) {
    return new SerializedResolvedVariable({ name, reason: 'unrecognized_variable', value: undefined })
  }
  const resolved = resolveValue(variableConfig, targetingKey, attributes)
  return serializedResolvedFromValue(variableConfig.name, resolved)
}

function resolveSerializedValueForLabel(config: VariablesConfig, name: string, label: string): SerializedResolvedVariable {
  const variableConfig = getVariableConfig(config, name)
  if (variableConfig === undefined) {
    return new SerializedResolvedVariable({ name, reason: 'unrecognized_variable', value: undefined })
  }
  return resolveVariableConfigForLabel(variableConfig, label)
}

function resolveVariableConfigForLabel(config: VariableConfig, label: string): SerializedResolvedVariable {
  const labeled = config.labels[label]
  if (labeled === undefined) {
    return new SerializedResolvedVariable({ name: config.name, reason: 'resolved', value: undefined })
  }
  const followed = followRef(config, labeled)
  return serializedResolvedFromValue(config.name, {
    label,
    serializedValue: followed.serializedValue,
    version: followed.version,
  })
}

function serializedResolvedFromValue(
  name: string,
  resolved: { label: string | undefined; serializedValue: string | undefined; version: number | undefined }
): SerializedResolvedVariable {
  const init: SerializedResolvedVariableInit = {
    name,
    reason: 'resolved',
    value: resolved.serializedValue,
  }
  if (resolved.label !== undefined) {
    init.label = resolved.label
  }
  if (resolved.version !== undefined) {
    init.version = resolved.version
  }
  return new SerializedResolvedVariable(init)
}

function resolveValue(
  config: VariableConfig,
  targetingKey?: string,
  attributes?: Record<string, unknown>
): { label: string | undefined; serializedValue: string | undefined; version: number | undefined } {
  const selectedLabel = resolveLabel(config, targetingKey, attributes)
  if (selectedLabel !== undefined) {
    const labeled = config.labels[selectedLabel]
    if (labeled !== undefined) {
      const followed = followRef(config, labeled)
      return { label: selectedLabel, serializedValue: followed.serializedValue, version: followed.version }
    }
  }
  return { label: undefined, serializedValue: undefined, version: undefined }
}

function resolveLabel(config: VariableConfig, targetingKey?: string, attributes: Record<string, unknown> = {}): string | undefined {
  let rollout = config.rollout
  for (const override of config.overrides) {
    if (matchesAllConditions(override.conditions, attributes)) {
      rollout = override.rollout
      break
    }
  }
  return selectRolloutLabel(rollout, targetingKey === undefined ? undefined : `${config.name}:${targetingKey}`)
}

function selectRolloutLabel(rollout: Rollout, seed?: string): string | undefined {
  const entries = Object.entries(rollout.labels)
  if (entries.length === 0) {
    return undefined
  }
  const random = seed === undefined ? Math.random() : seededRandom(seed)
  let cumulative = 0
  for (const [label, weight] of entries) {
    cumulative += weight
    if (random < cumulative) {
      return label
    }
  }
  return undefined
}

function seededRandom(seed: string): number {
  const hash = murmurhash3x64128(seed).slice(0, 13)
  return Number.parseInt(hash, 16) / 0x10000000000000
}

function followRef(
  config: VariableConfig,
  labeled: LabelRef | LabeledValue,
  visited: Set<string> = new Set<string>()
): { serializedValue: string | undefined; version: number | undefined } {
  if (isLabeledValue(labeled)) {
    return { serializedValue: labeled.serialized_value, version: labeled.version }
  }
  if (labeled.ref === 'code_default') {
    return { serializedValue: undefined, version: undefined }
  }
  if (labeled.ref === 'latest') {
    return {
      serializedValue: config.latest_version?.serialized_value,
      version: config.latest_version?.version ?? labeled.version ?? undefined,
    }
  }
  if (visited.has(labeled.ref)) {
    return { serializedValue: undefined, version: labeled.version ?? undefined }
  }
  visited.add(labeled.ref)
  const next = config.labels[labeled.ref]
  if (next === undefined) {
    return { serializedValue: undefined, version: labeled.version ?? undefined }
  }
  return followRef(config, next, visited)
}

function getVariableConfig(config: VariablesConfig, name: string): VariableConfig | undefined {
  const direct = config.variables[name]
  if (direct !== undefined) {
    return direct
  }
  for (const variableConfig of Object.values(config.variables)) {
    if (variableConfig.aliases?.includes(name) === true) {
      return variableConfig
    }
  }
  return undefined
}

function matchesAllConditions(conditions: Condition[], attributes: Record<string, unknown>): boolean {
  return conditions.every((condition) => matchesCondition(condition, attributes))
}

function matchesCondition(condition: Condition, attributes: Record<string, unknown>): boolean {
  switch (condition.kind) {
    case 'key-is-not-present':
      return !Object.hasOwn(attributes, condition.attribute)
    case 'key-is-present':
      return Object.hasOwn(attributes, condition.attribute)
    case 'value-does-not-equal':
      return attributes[condition.attribute] !== condition.value
    case 'value-does-not-match-regex': {
      const value = attributes[condition.attribute]
      return typeof value !== 'string' || !new RegExp(condition.pattern).test(value)
    }
    case 'value-equals':
      return attributes[condition.attribute] === condition.value
    case 'value-is-in':
      return condition.values.some((value) => value === attributes[condition.attribute])
    case 'value-is-not-in':
      return condition.values.every((value) => value !== attributes[condition.attribute])
    case 'value-matches-regex': {
      const value = attributes[condition.attribute]
      return typeof value === 'string' && new RegExp(condition.pattern).test(value)
    }
    default:
      return assertNever(condition)
  }
}

function normalizeVariablesConfig(data: unknown): VariablesConfig {
  if (!isRecord(data)) {
    throw new Error('Variables config must be an object')
  }
  const rawVariables = data['variables']
  if (!isRecord(rawVariables)) {
    throw new Error('Variables config requires a variables object')
  }
  const variables: Record<string, VariableConfig> = {}
  for (const [key, value] of Object.entries(rawVariables)) {
    const variableConfig = normalizeVariableConfig(value)
    if (variableConfig.name !== key) {
      throw new Error(`variables has invalid lookup key '${key}' for variable '${variableConfig.name}'`)
    }
    variables[key] = variableConfig
  }
  return { variables }
}

function normalizeVariableConfig(data: unknown): VariableConfig {
  if (!isRecord(data)) {
    throw new Error('Variable config must be an object')
  }
  const name = expectString(data['name'], 'variable.name')
  validateVariableName(name)
  const labels = normalizeLabels(data['labels'] ?? {})
  validateLabelRefs(labels)
  const rollout = normalizeRollout(data['rollout'] ?? { labels: {} }, labels)
  const overrides = normalizeOverrides(data['overrides'] ?? [], labels)
  const latestVersion =
    data['latest_version'] === undefined || data['latest_version'] === null ? null : normalizeLatestVersion(data['latest_version'])
  const config: VariableConfig = {
    description: optionalString(data['description']),
    example: optionalString(data['example']),
    json_schema: isRecord(data['json_schema']) ? data['json_schema'] : null,
    labels,
    latest_version: latestVersion,
    name,
    overrides,
    rollout,
    type_name: optionalString(data['type_name']),
  }
  const aliases = data['aliases']
  if (Array.isArray(aliases)) {
    config.aliases = aliases.map((alias) => {
      const normalizedAlias = expectString(alias, 'variable.alias')
      validateVariableName(normalizedAlias)
      return normalizedAlias
    })
  } else if (aliases === null) {
    config.aliases = null
  }
  return config
}

function normalizeLabels(data: unknown): Record<string, LabelRef | LabeledValue> {
  if (!isRecord(data)) {
    throw new Error('Variable labels must be an object')
  }
  const labels: Record<string, LabelRef | LabeledValue> = {}
  for (const [label, raw] of Object.entries(data)) {
    if (!isRecord(raw)) {
      throw new Error(`Label '${label}' must be an object`)
    }
    if (typeof raw['serialized_value'] === 'string' && typeof raw['version'] === 'number') {
      labels[label] = { serialized_value: raw['serialized_value'], version: raw['version'] }
    } else if (typeof raw['ref'] === 'string') {
      labels[label] = { ref: raw['ref'], version: typeof raw['version'] === 'number' ? raw['version'] : null }
    } else if (typeof raw['target_type'] === 'string') {
      labels[label] = normalizeApiLabel(raw)
    } else {
      throw new Error(`Label '${label}' must contain serialized_value/version, ref, or target_type`)
    }
  }
  return labels
}

function validateLabelRefs(labels: Record<string, LabelRef | LabeledValue>): void {
  for (const [label, labeledValue] of Object.entries(labels)) {
    if (isLabeledValue(labeledValue) || labeledValue.ref === 'latest' || labeledValue.ref === 'code_default') {
      continue
    }
    if (!Object.hasOwn(labels, labeledValue.ref)) {
      throw new Error(`Label '${label}' has ref '${labeledValue.ref}' which is not present in labels`)
    }
  }
}

function normalizeApiLabel(raw: Record<string, unknown>): LabelRef | LabeledValue {
  const targetType = raw['target_type']
  if (targetType === 'version') {
    return {
      serialized_value: expectString(raw['serialized_value'], 'label.serialized_value'),
      version: expectNumber(raw['version'], 'label.version'),
    }
  }
  if (targetType === 'latest') {
    return { ref: 'latest' }
  }
  if (targetType === 'code_default') {
    return { ref: 'code_default' }
  }
  if (targetType === 'label') {
    return { ref: expectString(raw['target_label'], 'label.target_label') }
  }
  throw new Error(`Unknown label target_type '${formatUnknown(targetType)}'`)
}

function normalizeLatestVersion(data: unknown): LatestVersion {
  if (!isRecord(data)) {
    throw new Error('latest_version must be an object')
  }
  return {
    serialized_value: expectString(data['serialized_value'], 'latest_version.serialized_value'),
    version: expectNumber(data['version'], 'latest_version.version'),
  }
}

function normalizeRollout(data: unknown, labels: Record<string, LabelRef | LabeledValue>): Rollout {
  if (!isRecord(data) || !isRecord(data['labels'])) {
    throw new Error('Rollout requires a labels object')
  }
  const rolloutLabels: Record<string, number> = {}
  let total = 0
  for (const [label, weight] of Object.entries(data['labels'])) {
    if (!Object.hasOwn(labels, label)) {
      throw new Error(`Label '${label}' present in rollout.labels is not present in labels`)
    }
    const normalizedWeight = expectNumber(weight, `rollout.labels.${label}`)
    if (normalizedWeight < 0) {
      throw new Error('Label proportions must not be negative')
    }
    total += normalizedWeight
    rolloutLabels[label] = normalizedWeight
  }
  if (total > 1.0 + 1e-9) {
    throw new Error('Label proportions must not sum to more than 1')
  }
  return { labels: rolloutLabels }
}

function normalizeOverrides(data: unknown, labels: Record<string, LabelRef | LabeledValue>): RolloutOverride[] {
  if (!Array.isArray(data)) {
    throw new Error('overrides must be an array')
  }
  return data.map((item) => {
    if (!isRecord(item) || !Array.isArray(item['conditions'])) {
      throw new Error('Each rollout override requires conditions')
    }
    return {
      conditions: item['conditions'].map(normalizeCondition),
      rollout: normalizeRollout(item['rollout'], labels),
    }
  })
}

function normalizeCondition(data: unknown): Condition {
  if (!isRecord(data)) {
    throw new Error('Condition must be an object')
  }
  const kind = data['kind']
  const attribute = expectString(data['attribute'], 'condition.attribute')
  if (kind === 'key-is-not-present' || kind === 'key-is-present') {
    return { attribute, kind }
  }
  if (kind === 'value-does-not-equal' || kind === 'value-equals') {
    return { attribute, kind, value: data['value'] }
  }
  if (kind === 'value-is-in' || kind === 'value-is-not-in') {
    if (!Array.isArray(data['values'])) {
      throw new Error('Condition values must be an array')
    }
    return { attribute, kind, values: data['values'] }
  }
  if (kind === 'value-does-not-match-regex' || kind === 'value-matches-regex') {
    return { attribute, kind, pattern: expectString(data['pattern'], 'condition.pattern') }
  }
  throw new Error(`Unknown condition kind '${formatUnknown(kind)}'`)
}

function normalizeVariableTypeConfig(data: unknown): VariableTypeConfig {
  if (!isRecord(data)) {
    throw new Error('Variable type config must be an object')
  }
  const jsonSchema = data['json_schema']
  if (!isRecord(jsonSchema)) {
    throw new Error('Variable type config requires json_schema')
  }
  return {
    description: optionalString(data['description']),
    json_schema: jsonSchema,
    name: expectString(data['name'], 'variable_type.name'),
    source_hint: optionalString(data['source_hint']),
  }
}

function configToApiBody(config: VariableConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    aliases: config.aliases ?? undefined,
    description: config.description ?? null,
    example: config.example ?? undefined,
    json_schema: config.json_schema ?? undefined,
    name: config.name,
    overrides: config.overrides.map((override) => ({
      conditions: override.conditions,
      rollout: { labels: override.rollout.labels },
    })),
    rollout: { labels: config.rollout.labels },
  }
  if (Object.keys(config.labels).length > 0) {
    body['labels'] = Object.fromEntries(Object.entries(config.labels).map(([label, value]) => [label, labelToApiData(value)]))
  }
  return body
}

function labelToApiData(label: LabelRef | LabeledValue): Record<string, unknown> {
  if (isLabeledValue(label)) {
    return { serialized_value: label.serialized_value, target_type: 'version', version: label.version }
  }
  if (label.ref === 'latest') {
    return { target_type: 'latest' }
  }
  if (label.ref === 'code_default') {
    return { target_type: 'code_default' }
  }
  return { target_label: label.ref, target_type: 'label' }
}

function getMergedAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (runtimeState.includeResourceAttributesInContext) {
    Object.assign(result, runtimeState.resourceAttributes)
  }
  if (runtimeState.includeBaggageInContext) {
    const baggage = propagation.getActiveBaggage()
    if (baggage !== undefined) {
      for (const [key, entry] of baggage.getAllEntries()) {
        result[key] = entry.value
      }
    }
  }
  if (attributes !== undefined) {
    Object.assign(result, attributes)
  }
  return result
}

function shouldInstrumentVariables(): boolean {
  return runtimeState.instrument
}

interface TargetingContextData {
  byVariable: Record<string, string>
  defaultKey: string | undefined
}

const TARGETING_CONTEXT_KEY = createContextKey('logfire.vars.targeting_context')
const OVERRIDE_CONTEXT_KEY = createContextKey('logfire.vars.override_context')
let fallbackTargetingContext: TargetingContextData = { byVariable: {}, defaultKey: undefined }
let fallbackOverrideContext: Record<string, unknown> = {}

function getTargetingContext(): TargetingContextData {
  const value = ContextAPI.active().getValue(TARGETING_CONTEXT_KEY)
  if (isTargetingContextData(value)) {
    return value
  }
  return fallbackTargetingContext
}

async function withTargetingContext<R>(data: TargetingContextData, callback: () => Promise<R> | R): Promise<R> {
  const active = ContextAPI.active().setValue(TARGETING_CONTEXT_KEY, data)
  const previous = fallbackTargetingContext
  fallbackTargetingContext = data
  try {
    return await ContextAPI.with(active, async () => await callback())
  } finally {
    fallbackTargetingContext = previous
  }
}

function getContextTargetingKey(variableName: string): string | undefined {
  const ctx = getTargetingContext()
  return ctx.byVariable[variableName] ?? ctx.defaultKey
}

function getOverrideContext(): Record<string, unknown> {
  const value = ContextAPI.active().getValue(OVERRIDE_CONTEXT_KEY)
  if (isRecord(value)) {
    return value
  }
  return fallbackOverrideContext
}

async function withOverrideContext<R>(data: Record<string, unknown>, callback: () => Promise<R> | R): Promise<R> {
  const active = ContextAPI.active().setValue(OVERRIDE_CONTEXT_KEY, data)
  const previous = fallbackOverrideContext
  fallbackOverrideContext = data
  try {
    return await ContextAPI.with(active, async () => await callback())
  } finally {
    fallbackOverrideContext = previous
  }
}

function getActiveTraceTargetingKey(): string | undefined {
  const span = TraceAPI.getSpan(ContextAPI.active())
  const traceId = span?.spanContext().traceId
  if (traceId === undefined || /^0+$/.test(traceId)) {
    return undefined
  }
  return `trace_id:${traceId}`
}

function isTargetingContextData(value: unknown): value is TargetingContextData {
  return isRecord(value) && isRecord(value['byVariable'])
}

function validateVariableName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid variable name '${name}'. Variable names must start with a letter or underscore.`)
  }
}

function isLocalVariablesOptions(options: VariablesConfigOptions): options is LocalVariablesOptions {
  return isRecord(options) && isRecord(options['config'])
}

function isLabeledValue(value: LabelRef | LabeledValue): value is LabeledValue {
  return 'serialized_value' in value
}

function isSyntaxOrValidationError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof TypeError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`)
  }
  return value
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error('Expected string or null')
  }
  return value
}

function normalizeDescriptionForComparison(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : value
}

function expectNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`)
  }
  return value
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function shutdownProvider(provider: VariableProvider): void {
  Promise.resolve(provider.shutdown?.()).catch(ignoreBackgroundError)
}

function ignoreBackgroundError(): void {
  // Background variable refresh/shutdown failures are intentionally best-effort.
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function toVariableWriteError(message: string, error: unknown): VariableWriteError {
  return new VariableWriteError(`${message}: ${error instanceof Error ? error.message : formatUnknown(error)}`)
}

function withoutKey<T>(record: Record<string, T>, keyToRemove: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToRemove))
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${formatUnknown(value)}`)
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value)
  }
  if (value === null) {
    return 'null'
  }
  if (value === undefined) {
    return 'undefined'
  }
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
