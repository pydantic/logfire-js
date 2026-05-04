import type { SamplingOptions } from 'logfire'
import type { VariablesConfigOptions } from 'logfire/vars'

import type { DiagLogLevel } from '@opentelemetry/api'
import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import type { IdGenerator, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfireApi from 'logfire'

import { start } from './sdk'

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
   * Settings for the source code of the project.
   */
  codeSource?: CodeSource
  /**
   * Whether to log the spans to the console in addition to sending them to the Logfire API.
   */
  console?: boolean
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
   * Additional third-party instrumentations to use.
   */
  instrumentations?: Instrumentation[]
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
   * Defaults to the `LOGFIRE_SERVICE_NAME` environment variable.
   */
  serviceName?: string
  /**
   * Version of this service.
   * Defaults to the `LOGFIRE_SERVICE_VERSION` environment variable.
   */
  serviceVersion?: string
  /**
   * The project token.
   * Defaults to the `LOGFIRE_TOKEN` environment variable.
   */
  token?: string
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

export interface LogfireConfig {
  additionalSpanProcessors: SpanProcessor[]
  apiKey: string | undefined
  authorizationHeaders: Record<string, string>
  baseUrl: string
  codeSource: CodeSource | undefined
  console: boolean | undefined
  deploymentEnvironment: string | undefined
  diagLogLevel?: DiagLogLevel
  distributedTracing: boolean
  idGenerator: IdGenerator
  instrumentations: Instrumentation[]
  logsExporterUrl: string
  metricExporterUrl: string
  metrics: false | MetricsOptions | undefined
  nodeAutoInstrumentations: InstrumentationConfigMap
  otelScope: string
  sampling: SamplingOptions | undefined
  sendToLogfire: boolean
  serviceName: string | undefined
  serviceVersion: string | undefined
  token: string | undefined
  traceExporterUrl: string
  variables: VariablesConfigOptions
  variablesBaseUrl: string | undefined
}

const DEFAULT_LOGFIRE_CONFIG: LogfireConfig = {
  additionalSpanProcessors: [],
  apiKey: undefined,
  authorizationHeaders: {},
  baseUrl: '',
  codeSource: undefined,
  console: false,
  deploymentEnvironment: undefined,
  distributedTracing: true,
  idGenerator: new logfireApi.ULIDGenerator(),
  instrumentations: [],
  logsExporterUrl: '',
  metricExporterUrl: '',
  metrics: undefined,
  nodeAutoInstrumentations: DEFAULT_AUTO_INSTRUMENTATION_CONFIG,
  otelScope: DEFAULT_OTEL_SCOPE,
  sampling: undefined,
  sendToLogfire: false,
  serviceName: process.env['LOGFIRE_SERVICE_NAME'],
  serviceVersion: process.env['LOGFIRE_SERVICE_VERSION'],
  token: '',
  traceExporterUrl: '',
  variables: undefined,
  variablesBaseUrl: undefined,
}

export const logfireConfig: LogfireConfig = DEFAULT_LOGFIRE_CONFIG

export function configure(config: LogfireConfigOptions = {}): void {
  const { errorFingerprinting, otelScope, sampling, scrubbing, ...cnf } = config

  const env = process.env

  if (errorFingerprinting !== undefined || otelScope !== undefined || scrubbing !== undefined) {
    const apiConfig: logfireApi.LogfireApiConfigOptions = {}
    if (errorFingerprinting !== undefined) {
      apiConfig.errorFingerprinting = errorFingerprinting
    }
    if (otelScope !== undefined) {
      apiConfig.otelScope = otelScope
    }
    if (scrubbing !== undefined) {
      apiConfig.scrubbing = scrubbing
    }
    logfireApi.configureLogfireApi(apiConfig)
  }

  const token = cnf.token ?? env['LOGFIRE_TOKEN']
  const apiKey = cnf.apiKey ?? env['LOGFIRE_API_KEY']
  const sendToLogfire = logfireApi.resolveSendToLogfire(process.env, cnf.sendToLogfire, token)
  const baseUrl =
    !sendToLogfire || token === undefined || token === '' ? '' : logfireApi.resolveBaseUrl(process.env, cnf.advanced?.baseUrl, token)
  const console = 'console' in cnf ? cnf.console : env['LOGFIRE_CONSOLE'] === 'true'
  const deploymentEnvironment = cnf.environment ?? env['LOGFIRE_ENVIRONMENT']
  const serviceName = cnf.serviceName ?? env['LOGFIRE_SERVICE_NAME']
  const serviceVersion = cnf.serviceVersion ?? env['LOGFIRE_SERVICE_VERSION']
  const variablesBaseUrl =
    apiKey !== undefined && apiKey !== '' ? logfireApi.resolveBaseUrl(process.env, cnf.advanced?.baseUrl, apiKey) : cnf.advanced?.baseUrl
  if (requiresRemoteVariables(cnf.variables) && (apiKey === undefined || apiKey === '')) {
    throw new Error('Remote variables require an API key. Set LOGFIRE_API_KEY or pass apiKey to configure().')
  }

  Object.assign(logfireConfig, {
    additionalSpanProcessors: cnf.additionalSpanProcessors ?? [],
    apiKey,
    authorizationHeaders: {
      Authorization: token ?? '',
    },
    baseUrl,
    codeSource: cnf.codeSource,
    console,
    deploymentEnvironment,
    diagLogLevel: cnf.diagLogLevel,
    distributedTracing: resolveDistributedTracing(cnf.distributedTracing),
    idGenerator: cnf.advanced?.idGenerator ?? new logfireApi.ULIDGenerator(),
    instrumentations: cnf.instrumentations ?? [],
    logsExporterUrl: `${baseUrl}/${LOGS_ENDPOINT_PATH}`,
    metricExporterUrl: `${baseUrl}/${METRIC_ENDPOINT_PATH}`,
    metrics: cnf.metrics,
    nodeAutoInstrumentations: cnf.nodeAutoInstrumentations ?? DEFAULT_AUTO_INSTRUMENTATION_CONFIG,
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

function resolveDistributedTracing(option: LogfireConfigOptions['distributedTracing']) {
  const envDistributedTracing = process.env['LOGFIRE_DISTRIBUTED_TRACING']
  return (option ?? envDistributedTracing === undefined) ? true : envDistributedTracing === 'true'
}

function requiresRemoteVariables(options: VariablesConfigOptions): boolean {
  return options !== undefined && options !== false && !('config' in options)
}
