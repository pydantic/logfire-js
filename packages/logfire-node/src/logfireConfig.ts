import { DiagLogLevel } from '@opentelemetry/api'
import { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node'
import { Instrumentation } from '@opentelemetry/instrumentation'
import { MetricReader } from '@opentelemetry/sdk-metrics'
import { IdGenerator, SpanProcessor } from '@opentelemetry/sdk-trace-base'
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
}

const DEFAULT_OTEL_SCOPE = 'logfire'
const TRACE_ENDPOINT_PATH = 'v1/traces'
const METRIC_ENDPOINT_PATH = 'v1/metrics'
const DEFAULT_AUTO_INSTRUMENTATION_CONFIG: InstrumentationConfigMap = {
  // https://opentelemetry.io/docs/languages/js/libraries/#registration
  // This particular instrumentation creates a lot of noise on startup
  '@opentelemetry/instrumentation-fs': {
    enabled: false,
  },
}

export interface LogfireConfig {
  additionalSpanProcessors: SpanProcessor[]
  authorizationHeaders: Record<string, string>
  baseUrl: string
  codeSource: CodeSource | undefined
  console: boolean | undefined
  deploymentEnvironment: string | undefined
  diagLogLevel?: DiagLogLevel
  distributedTracing: boolean
  idGenerator: IdGenerator
  instrumentations: Instrumentation[]
  metricExporterUrl: string
  metrics: false | MetricsOptions | undefined
  nodeAutoInstrumentations: InstrumentationConfigMap
  otelScope: string
  sendToLogfire: boolean
  serviceName: string | undefined
  serviceVersion: string | undefined
  token: string | undefined
  traceExporterUrl: string
}

const DEFAULT_LOGFIRE_CONFIG: LogfireConfig = {
  additionalSpanProcessors: [],
  authorizationHeaders: {},
  baseUrl: '',
  codeSource: undefined,
  console: false,
  deploymentEnvironment: undefined,
  diagLogLevel: undefined,
  distributedTracing: true,
  idGenerator: new logfireApi.ULIDGenerator(),
  instrumentations: [],
  metricExporterUrl: '',
  metrics: undefined,
  nodeAutoInstrumentations: DEFAULT_AUTO_INSTRUMENTATION_CONFIG,
  otelScope: DEFAULT_OTEL_SCOPE,
  sendToLogfire: false,
  serviceName: process.env.LOGFIRE_SERVICE_NAME,
  serviceVersion: process.env.LOGFIRE_SERVICE_VERSION,
  token: '',
  traceExporterUrl: '',
}

export const logfireConfig: LogfireConfig = DEFAULT_LOGFIRE_CONFIG

export function configure(config: LogfireConfigOptions = {}) {
  const { otelScope, scrubbing, ...cnf } = config

  const env = process.env

  if (otelScope) {
    logfireApi.configureLogfireApi({ otelScope, scrubbing })
  }

  const token = cnf.token ?? env.LOGFIRE_TOKEN
  const sendToLogfire = logfireApi.resolveSendToLogfire(process.env, cnf.sendToLogfire, token)
  const baseUrl = !sendToLogfire || !token ? '' : logfireApi.resolveBaseUrl(process.env, cnf.advanced?.baseUrl, token)
  const console = 'console' in cnf ? cnf.console : env.LOGFIRE_CONSOLE === 'true'

  Object.assign(logfireConfig, {
    additionalSpanProcessors: cnf.additionalSpanProcessors ?? [],
    authorizationHeaders: {
      Authorization: token ?? '',
    },
    baseUrl,
    codeSource: cnf.codeSource,
    console,
    deploymentEnvironment: cnf.environment ?? env.LOGFIRE_ENVIRONMENT,
    diagLogLevel: cnf.diagLogLevel,
    distributedTracing: resolveDistributedTracing(cnf.distributedTracing),
    idGenerator: cnf.advanced?.idGenerator ?? new logfireApi.ULIDGenerator(),
    instrumentations: cnf.instrumentations ?? [],
    metricExporterUrl: `${baseUrl}/${METRIC_ENDPOINT_PATH}`,
    metrics: cnf.metrics,
    nodeAutoInstrumentations: cnf.nodeAutoInstrumentations ?? DEFAULT_AUTO_INSTRUMENTATION_CONFIG,
    sendToLogfire,
    serviceName: cnf.serviceName ?? env.LOGFIRE_SERVICE_NAME,
    serviceVersion: cnf.serviceVersion ?? env.LOGFIRE_SERVICE_VERSION,
    token,
    traceExporterUrl: `${baseUrl}/${TRACE_ENDPOINT_PATH}`,
  })

  start()
}

function resolveDistributedTracing(option: LogfireConfigOptions['distributedTracing']) {
  const envDistributedTracing = process.env.LOGFIRE_DISTRIBUTED_TRACING
  return (option ?? envDistributedTracing === undefined) ? true : envDistributedTracing === 'true'
}
