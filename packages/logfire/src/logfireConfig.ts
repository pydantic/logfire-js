import { DiagLogLevel } from '@opentelemetry/api'
import { MetricReader } from '@opentelemetry/sdk-metrics'
import { IdGenerator, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfireApi from '@pydantic/logfire-api'

import { start } from './sdk'
import { ULIDGenerator } from './ULIDGenerator'

export interface AdancedLogfireConfigOptions {
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

export interface SrubbingOptions {
  callback?: logfireApi.ScrubCallback
  extraPatterns?: string[]
}

export interface LogfireConfigOptions {
  /**
   * Additional span processors to be added to the OpenTelemetry SDK
   */
  additionalSpanProcessors?: SpanProcessor[]
  /**
   * Advanced configuration options
   */
  advanced?: AdancedLogfireConfigOptions
  /**
   * Settings for the source code of the project.
   */
  codeSource?: CodeSource
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
   * Set to False to disable sending all metrics, or provide a MetricsOptions object to configure metrics, e.g. additional metric readers.
   */
  metrics?: false | MetricsOptions
  /**
   * The otel scope to use for the logfire API. Defaults to 'logfire'.
   */
  otelScope?: string
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | SrubbingOptions
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

const DEFAULT_LOGFIRE_BASE_URL = 'https://logfire-api.pydantic.dev/'
const DEFAULT_OTEL_SCOPE = 'logfire'
const TRACE_ENDPOINT_PATH = 'v1/traces'
const METRIC_ENDPOINT_PATH = 'v1/metrics'

export interface LogfireConfig {
  additionalSpanProcessors: SpanProcessor[]
  authorizationHeaders: Record<string, string>
  baseUrl: string
  codeSource: CodeSource | undefined
  deployEnvironment: string | undefined
  deploymentEnvironment: string | undefined
  diagLogLevel?: DiagLogLevel
  distributedTracing: boolean
  idGenerator: IdGenerator
  metricExporterUrl: string
  metrics: false | MetricsOptions | undefined
  otelScope: string
  scrubber: logfireApi.AttributeScrubber
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
  deployEnvironment: undefined,
  deploymentEnvironment: undefined,
  diagLogLevel: undefined,
  distributedTracing: true,
  idGenerator: new ULIDGenerator(),
  metricExporterUrl: '',
  metrics: undefined,
  otelScope: DEFAULT_OTEL_SCOPE,
  scrubber: new logfireApi.LogfireAttributeScrubber(),
  sendToLogfire: false,
  serviceName: process.env.LOGFIRE_SERVICE_NAME,
  serviceVersion: process.env.LOGFIRE_SERVICE_VERSION,
  token: '',
  traceExporterUrl: '',
}

export const logfireConfig: LogfireConfig = DEFAULT_LOGFIRE_CONFIG

export function configure(config: LogfireConfigOptions = {}) {
  const { otelScope, ...cnf } = config

  const env = process.env

  if (otelScope) {
    logfireApi.configureLogfireApi({ otelScope })
  }

  const baseUrl = resolveBaseUrl(cnf.advanced?.baseUrl)
  const token = cnf.token ?? env.LOGFIRE_TOKEN

  Object.assign(logfireConfig, {
    additionalSpanProcessors: cnf.additionalSpanProcessors ?? [],
    authorizationHeaders: {
      Authorization: token ?? '',
    },
    baseUrl,
    codeSource: cnf.codeSource,
    deployEnvironment: cnf.environment ?? env.LOGFIRE_ENVIRONMENT,
    diagLogLevel: cnf.diagLogLevel,
    distributedTracing: resolveDistributedTracing(cnf.distributedTracing),
    idGenerator: cnf.advanced?.idGenerator ?? new ULIDGenerator(),
    metricExporterUrl: `${baseUrl}/${METRIC_ENDPOINT_PATH}`,
    metrics: cnf.metrics,
    scrubber: resolveScrubber(cnf.scrubbing),
    sendToLogfire: resolveSendToLogfire(cnf.sendToLogfire, token),
    serviceName: cnf.serviceName ?? env.LOGFIRE_SERVICE_NAME,
    serviceVersion: cnf.serviceVersion ?? env.LOGFIRE_SERVICE_VERSION,
    token,
    traceExporterUrl: `${baseUrl}/${TRACE_ENDPOINT_PATH}`,
  })

  start()
}

function resolveScrubber(scrubbing: LogfireConfigOptions['scrubbing']) {
  if (scrubbing !== undefined) {
    if (scrubbing === false) {
      return new logfireApi.NoopAttributeScrubber()
    } else {
      return new logfireApi.LogfireAttributeScrubber(scrubbing.extraPatterns, scrubbing.callback)
    }
  } else {
    return new logfireApi.LogfireAttributeScrubber()
  }
}

function resolveSendToLogfire(option: LogfireConfigOptions['sendToLogfire'], token: string | undefined) {
  const sendToLogfireConfig = option ?? process.env.LOGFIRE_SEND_TO_LOGFIRE ?? 'if-token-present'

  if (sendToLogfireConfig === 'if-token-present') {
    if (token) {
      return true
    } else {
      return false
    }
  } else {
    return Boolean(sendToLogfireConfig)
  }
}

function resolveBaseUrl(option: string | undefined) {
  let url = option ?? process.env.LOGFIRE_BASE_URL ?? DEFAULT_LOGFIRE_BASE_URL
  if (url.endsWith('/')) {
    url = url.slice(0, -1)
  }
  return url
}

function resolveDistributedTracing(option: LogfireConfigOptions['distributedTracing']) {
  const envDistributedTracing = process.env.LOGFIRE_DISTRIBUTED_TRACING
  return (option ?? envDistributedTracing === undefined) ? true : envDistributedTracing === 'true'
}
