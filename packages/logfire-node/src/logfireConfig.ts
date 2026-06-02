import type { BaggageOptions, JsonSchemaMode, LogFireLevel, MinLevel, SamplingOptions } from 'logfire'
import type { VariablesConfigOptions } from 'logfire/vars'

import type { Attributes, DiagLogLevel } from '@opentelemetry/api'
import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import type { IdGenerator, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfireApi from 'logfire'

import type { ConsoleConfig } from './consoleOptions'
import { resolveConsoleOptions } from './consoleOptions'
import { start } from './sdk'

export type { ConsoleConfig, ConsoleOptions } from './consoleOptions'

export interface AdvancedLogfireConfigOptions {
  /**
   * The logfire API base URL. Defaults to 'https://logfire-api.pydantic.dev/'
   */
  baseUrl?: string
  /**
   * The generator to use for generating trace IDs. Defaults to ULIDGenerator - https://github.com/ulid/spec.
   */
  idGenerator?: IdGenerator
}

export interface CodeSource {
  /**
   * The repository URL for the code e.g. https://github.com/pydantic/logfire
   */
  repository: string
  /**
   * The git revision of the code e.g. branch name, commit hash, tag name etc.
   */
  revision: string
  /**
   * The root path for the source code in the repository.
   *
   * If you run the code from the directory corresponding to the root of the repository, you can leave this blank.
   */
  rootPath?: string
}

export interface MetricsOptions {
  additionalReaders: MetricReader[]
}

export type LogfireToken = string | (() => string | Promise<string>)
export type AuthorizationHeaders = Record<string, string> | (() => Promise<Record<string, string>>)

export interface LogfireConfigOptions {
  /**
   * Additional span processors to be added to the OpenTelemetry SDK
   */
  additionalSpanProcessors?: SpanProcessor[]
  /**
   * API key for Logfire platform APIs, including managed variables.
   * Defaults to the `LOGFIRE_API_KEY` environment variable.
   */
  apiKey?: string
  /**
   * Advanced configuration options
   */
  advanced?: AdvancedLogfireConfigOptions
  /**
   * Active OpenTelemetry baggage keys to copy to Logfire manual spans/logs as span attributes.
   */
  baggage?: BaggageOptions
  /**
   * Settings for the source code of the project.
   */
  codeSource?: CodeSource
  /**
   * Whether to log the spans to the console in addition to sending them to the Logfire API.
   */
  console?: ConsoleConfig
  /**
   * Defines the available internal logging levels for the diagnostic logger.
   */
  diagLogLevel?: DiagLogLevel
  /**
   * Set to False to suppress extraction of incoming trace context. See [Unintentional Distributed Tracing](https://logfire.pydantic.dev/docs/how-to-guides/distributed-tracing/#unintentional-distributed-tracing) for more information.
   */
  distributedTracing?: boolean
  /**
   * The environment this service is running in, e.g. `staging` or `prod`. Sets the deployment.environment.name resource attribute. Useful for filtering within projects in the Logfire UI.
   * Defaults to the `LOGFIRE_ENVIRONMENT` environment variable.
   */
  environment?: string
  /**
   * Whether to compute fingerprints for errors reported via reportError().
   * Fingerprints enable error grouping in the Logfire backend.
   * Defaults to true for Node.js.
   */
  errorFingerprinting?: boolean
  /**
   * Controls JSON schema metadata for serialized object/array attributes.
   *
   * Defaults to 'rich'. Use 'basic' for legacy broad schemas, or false to omit schema metadata.
   */
  jsonSchema?: JsonSchemaMode
  /**
   * Additional third-party instrumentations to use.
   */
  instrumentations?: Instrumentation[]
  /**
   * Minimum Logfire level to emit for manual log-like spans.
   *
   * Accepts lowercase level names (trace, debug, info, notice, warning, error, fatal)
   * or numeric values from `logfire.Level`. Set to null to disable a previously configured minimum.
   * Defaults to the `LOGFIRE_MIN_LEVEL` environment variable when omitted.
   */
  minLevel?: MinLevel | null
  /**
   * Set to False to disable sending all metrics, or provide a MetricsOptions object to configure metrics, e.g. additional metric readers.
   */
  metrics?: false | MetricsOptions
  /**
   * The node auto instrumentations to use. See [Node Auto Instrumentations](https://opentelemetry.io/docs/languages/js/libraries/#registration) for more information.
   */
  nodeAutoInstrumentations?: InstrumentationConfigMap
  /**
   * The otel scope to use for the logfire API. Defaults to 'logfire'.
   */
  otelScope?: string
  /**
   * Additional OpenTelemetry resource attributes for the entity producing telemetry.
   */
  resourceAttributes?: Attributes
  /**
   * Sampling options for controlling which traces are exported.
   * `head` sets a probabilistic sample rate (0.0-1.0) at trace creation time.
   * `tail` provides a callback evaluated on every span to decide whether to keep the trace.
   * Defaults to the `LOGFIRE_TRACE_SAMPLE_RATE` environment variable for head sampling.
   */
  sampling?: SamplingOptions
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | logfireApi.ScrubbingOptions
  /**
   * Whether to send logs to logfire.dev.
   * Defaults to the `LOGFIRE_SEND_TO_LOGFIRE` environment variable if set, otherwise defaults to True. If if-token-present is provided, logs will only be sent if a token is present.
   */
  sendToLogfire?: 'if-token-present' | boolean
  /**
   * Name of this service.
   * Defaults to the `LOGFIRE_SERVICE_NAME` environment variable, then `OTEL_SERVICE_NAME`.
   */
  serviceName?: string
  /**
   * Version of this service.
   * Defaults to the `LOGFIRE_SERVICE_VERSION` environment variable, then `OTEL_SERVICE_VERSION`.
   */
  serviceVersion?: string
  /**
   * The project token, or a function returning the Authorization header value for rotating auth.
   * Token functions are resolved by the OpenTelemetry exporter when telemetry is exported.
   * When using a token function, set `advanced.baseUrl` or `LOGFIRE_BASE_URL` because Logfire cannot infer the base URL from the token.
   * Defaults to the `LOGFIRE_TOKEN` environment variable.
   */
  token?: LogfireToken
  /**
   * Managed variables configuration. Omit this to lazily use the remote provider
   * when `apiKey` / `LOGFIRE_API_KEY` is available, pass `false` to disable
   * managed variables, or pass local/remote provider options from `logfire/vars`.
   */
  variables?: VariablesConfigOptions
}

const DEFAULT_OTEL_SCOPE = 'logfire'
const TRACE_ENDPOINT_PATH = 'v1/traces'
const METRIC_ENDPOINT_PATH = 'v1/metrics'
const LOGS_ENDPOINT_PATH = 'v1/logs'
const DEFAULT_AUTO_INSTRUMENTATION_CONFIG: InstrumentationConfigMap = {
  // https://opentelemetry.io/docs/languages/js/libraries/#registration
  // This particular instrumentation creates a lot of noise on startup
  '@opentelemetry/instrumentation-fs': {
    enabled: false,
  },
}

function readNonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  return value === undefined || value.trim() === '' ? undefined : value
}

function readServiceNameEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readNonEmptyEnv(env, 'LOGFIRE_SERVICE_NAME') ?? readNonEmptyEnv(env, 'OTEL_SERVICE_NAME')
}

function readServiceVersionEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readNonEmptyEnv(env, 'LOGFIRE_SERVICE_VERSION') ?? readNonEmptyEnv(env, 'OTEL_SERVICE_VERSION')
}

export interface LogfireConfig {
  additionalSpanProcessors: SpanProcessor[]
  apiKey: string | undefined
  authorizationHeaders: AuthorizationHeaders
  baggage: BaggageOptions
  baseUrl: string
  codeSource: CodeSource | undefined
  console: ConsoleConfig | undefined
  deploymentEnvironment: string | undefined
  diagLogLevel?: DiagLogLevel
  distributedTracing: boolean
  idGenerator: IdGenerator
  instrumentations: Instrumentation[]
  jsonSchema: JsonSchemaMode
  logsExporterUrl: string
  metricExporterUrl: string
  metrics: false | MetricsOptions | undefined
  minLevel: LogFireLevel | undefined
  nodeAutoInstrumentations: InstrumentationConfigMap
  otelScope: string
  resourceAttributes: Attributes
  sampling: SamplingOptions | undefined
  sendToLogfire: boolean
  serviceName: string | undefined
  serviceVersion: string | undefined
  token: LogfireToken | undefined
  traceExporterUrl: string
  variables: VariablesConfigOptions
  variablesBaseUrl: string | undefined
}

const DEFAULT_LOGFIRE_CONFIG: LogfireConfig = {
  additionalSpanProcessors: [],
  apiKey: undefined,
  authorizationHeaders: {},
  baggage: {
    spanAttributes: [],
  },
  baseUrl: '',
  codeSource: undefined,
  console: false,
  deploymentEnvironment: undefined,
  distributedTracing: true,
  idGenerator: new logfireApi.ULIDGenerator(),
  instrumentations: [],
  jsonSchema: 'rich',
  logsExporterUrl: '',
  metricExporterUrl: '',
  metrics: undefined,
  minLevel: undefined,
  nodeAutoInstrumentations: DEFAULT_AUTO_INSTRUMENTATION_CONFIG,
  otelScope: DEFAULT_OTEL_SCOPE,
  resourceAttributes: {},
  sampling: undefined,
  sendToLogfire: false,
  serviceName: readServiceNameEnv(process.env),
  serviceVersion: readServiceVersionEnv(process.env),
  token: '',
  traceExporterUrl: '',
  variables: undefined,
  variablesBaseUrl: undefined,
}

export const logfireConfig: LogfireConfig = DEFAULT_LOGFIRE_CONFIG

export function configure(config: LogfireConfigOptions = {}): void {
  const { baggage, errorFingerprinting, jsonSchema, minLevel, otelScope, sampling, scrubbing, ...cnf } = config

  const env = process.env
  const envMinLevel = env['LOGFIRE_MIN_LEVEL']
  const console = 'console' in cnf ? cnf.console : env['LOGFIRE_CONSOLE'] === 'true'

  resolveConsoleOptions(console)

  if (
    baggage !== undefined ||
    errorFingerprinting !== undefined ||
    jsonSchema !== undefined ||
    minLevel !== undefined ||
    envMinLevel !== undefined ||
    otelScope !== undefined ||
    scrubbing !== undefined
  ) {
    const apiConfig: logfireApi.LogfireApiConfigOptions = {}
    let minLevelSource: 'code' | 'env' | undefined
    if (baggage !== undefined) {
      apiConfig.baggage = baggage
    }
    if (errorFingerprinting !== undefined) {
      apiConfig.errorFingerprinting = errorFingerprinting
    }
    if (jsonSchema !== undefined) {
      apiConfig.jsonSchema = jsonSchema
    }
    if (otelScope !== undefined) {
      apiConfig.otelScope = otelScope
    }
    if (minLevel !== undefined) {
      apiConfig.minLevel = minLevel
      minLevelSource = 'code'
    } else if (envMinLevel !== undefined) {
      apiConfig.minLevel = envMinLevel as MinLevel
      minLevelSource = 'env'
    }
    if (scrubbing !== undefined) {
      apiConfig.scrubbing = scrubbing
    }
    const minLevelUpdated = configureSharedApi(apiConfig, minLevelSource)
    if (minLevelUpdated) {
      logfireConfig.minLevel = logfireApi.logfireApiConfig.minLevel
    }
  }

  const token = cnf.token ?? env['LOGFIRE_TOKEN']
  const apiKey = cnf.apiKey ?? env['LOGFIRE_API_KEY']
  const sendToLogfire = resolveSendToLogfire(cnf.sendToLogfire, token)
  const baseUrl = resolveBaseUrl(env, cnf.advanced?.baseUrl, token, sendToLogfire)
  const deploymentEnvironment = cnf.environment ?? env['LOGFIRE_ENVIRONMENT']
  const serviceName = cnf.serviceName ?? readServiceNameEnv(env)
  const serviceVersion = cnf.serviceVersion ?? readServiceVersionEnv(env)
  const variablesBaseUrl =
    apiKey !== undefined && apiKey !== '' ? logfireApi.resolveBaseUrl(process.env, cnf.advanced?.baseUrl, apiKey) : cnf.advanced?.baseUrl
  if (requiresRemoteVariables(cnf.variables) && (apiKey === undefined || apiKey === '')) {
    throw new Error('Remote variables require an API key. Set LOGFIRE_API_KEY or pass apiKey to configure().')
  }

  Object.assign(logfireConfig, {
    additionalSpanProcessors: cnf.additionalSpanProcessors ?? [],
    apiKey,
    authorizationHeaders: resolveAuthorizationHeaders(token),
    baggage: baggage !== undefined ? { spanAttributes: [...(baggage.spanAttributes ?? [])] } : logfireConfig.baggage,
    baseUrl,
    codeSource: cnf.codeSource,
    console,
    deploymentEnvironment,
    diagLogLevel: cnf.diagLogLevel,
    distributedTracing: resolveDistributedTracing(cnf.distributedTracing),
    idGenerator: cnf.advanced?.idGenerator ?? new logfireApi.ULIDGenerator(),
    instrumentations: cnf.instrumentations ?? [],
    jsonSchema: jsonSchema ?? logfireConfig.jsonSchema,
    logsExporterUrl: `${baseUrl}/${LOGS_ENDPOINT_PATH}`,
    metricExporterUrl: `${baseUrl}/${METRIC_ENDPOINT_PATH}`,
    metrics: cnf.metrics,
    minLevel: logfireConfig.minLevel,
    nodeAutoInstrumentations: cnf.nodeAutoInstrumentations ?? DEFAULT_AUTO_INSTRUMENTATION_CONFIG,
    resourceAttributes: cnf.resourceAttributes ?? {},
    sampling: resolveSampling(sampling),
    sendToLogfire,
    serviceName,
    serviceVersion,
    token,
    traceExporterUrl: `${baseUrl}/${TRACE_ENDPOINT_PATH}`,
    variables: cnf.variables,
    variablesBaseUrl,
  })

  start()
}

function configureSharedApi(apiConfig: logfireApi.LogfireApiConfigOptions, minLevelSource: 'code' | 'env' | undefined): boolean {
  try {
    logfireApi.configureLogfireApi(apiConfig)
    return minLevelSource !== undefined
  } catch (error) {
    if (minLevelSource !== 'env') {
      throw error
    }

    console.warn(`Invalid LOGFIRE_MIN_LEVEL value "${String(apiConfig.minLevel)}" ignored.`)
    const fallbackApiConfig = { ...apiConfig }
    delete fallbackApiConfig.minLevel
    if (Object.keys(fallbackApiConfig).length > 0) {
      logfireApi.configureLogfireApi(fallbackApiConfig)
    }
    return false
  }
}

function resolveSampling(option: SamplingOptions | undefined): SamplingOptions | undefined {
  const envRate = process.env['LOGFIRE_TRACE_SAMPLE_RATE']
  if (option) {
    return option
  }
  if (envRate !== undefined) {
    const rate = parseFloat(envRate)
    if (!isNaN(rate) && rate >= 0 && rate <= 1) {
      return { head: rate }
    }
  }
  return undefined
}

function resolveSendToLogfire(option: LogfireConfigOptions['sendToLogfire'], token: LogfireToken | undefined): boolean {
  if (typeof token === 'function') {
    return logfireApi.resolveSendToLogfire(process.env, option, '__logfire_token_provider__')
  }
  return logfireApi.resolveSendToLogfire(process.env, option, token)
}

function resolveBaseUrl(
  env: NodeJS.ProcessEnv,
  passedUrl: string | undefined,
  token: LogfireToken | undefined,
  sendToLogfire: boolean
): string {
  if (!sendToLogfire) {
    return ''
  }
  if (typeof token === 'function') {
    const baseUrl = passedUrl ?? env['LOGFIRE_BASE_URL']
    if (baseUrl === undefined || baseUrl === '') {
      throw new Error('advanced.baseUrl or LOGFIRE_BASE_URL is required when token is a function.')
    }
    return removeTrailingSlash(baseUrl)
  }
  if (token === undefined || token === '') {
    return ''
  }
  return logfireApi.resolveBaseUrl(env, passedUrl, token)
}

function removeTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function resolveAuthorizationHeaders(token: LogfireToken | undefined): AuthorizationHeaders {
  if (typeof token === 'function') {
    return async () => ({
      Authorization: await token(),
    })
  }
  return {
    Authorization: token ?? '',
  }
}

function resolveDistributedTracing(option: LogfireConfigOptions['distributedTracing']) {
  const envDistributedTracing = process.env['LOGFIRE_DISTRIBUTED_TRACING']
  return (option ?? envDistributedTracing === undefined) ? true : envDistributedTracing === 'true'
}

function requiresRemoteVariables(options: VariablesConfigOptions): boolean {
  return options !== undefined && options !== false && !('config' in options)
}
