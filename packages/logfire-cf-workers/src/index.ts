import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { TraceConfig } from '@pydantic/otel-cf-workers'
import { instrument as baseInstrument } from '@pydantic/otel-cf-workers'
import type { ScrubbingOptions } from 'logfire'
import {
  configureLogfireApi,
  debug,
  error,
  fatal,
  info,
  Level,
  log,
  logfireApiConfig,
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  span,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
} from 'logfire'

import { exportTailEventsToLogfire } from './exportTailEventsToLogfire'
import { LogfireCloudflareConsoleSpanExporter } from './LogfireCloudflareConsoleSpanExporter'
import { TailWorkerExporter } from './TailWorkerExporter'
export * from './exportTailEventsToLogfire'

type Env = Record<string, string | undefined>

type ConfigOptionsBase = Pick<
  TraceConfig,
  'environment' | 'fetch' | 'handlers' | 'instrumentation' | 'propagator' | 'sampling' | 'scope' | 'service'
>

export interface InProcessConfigOptions extends ConfigOptionsBase {
  /**
   * Additional span processors to add to the tracer provider.
   */
  additionalSpanProcessors?: SpanProcessor[]
  baseUrl?: string
  /**
   * Whether to log the spans to the console in addition to sending them to the Logfire API.
   */
  console?: boolean
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | ScrubbingOptions
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TailConfigOptions extends ConfigOptionsBase {}

function getInProcessConfig(config: InProcessConfigOptions): (env: Env) => TraceConfig {
  return (env: Env): TraceConfig => {
    const { LOGFIRE_ENVIRONMENT: envDeploymentEnvironment, LOGFIRE_TOKEN: token = '' } = env

    const baseUrl = resolveBaseUrl(env, config.baseUrl, token)
    const resolvedEnvironment = config.environment ?? envDeploymentEnvironment

    const additionalSpanProcessors = config.additionalSpanProcessors ?? []

    if (config.console === true) {
      additionalSpanProcessors.push(new SimpleSpanProcessor(new LogfireCloudflareConsoleSpanExporter()))
    }

    return {
      ...config,
      additionalSpanProcessors,
      environment: resolvedEnvironment,
      exporter: {
        headers: { Authorization: token },
        url: `${baseUrl}/v1/traces`,
      },
      idGenerator: new ULIDGenerator(),
      postProcessor: (spans: ReadableSpan[]) => postProcessAttributes(spans),
    } satisfies TraceConfig
  }
}

export function getTailConfig(config: TailConfigOptions): (env: Env) => TraceConfig {
  return (_env: Env): TraceConfig => {
    return {
      ...config,
      exporter: new TailWorkerExporter(),
      idGenerator: new ULIDGenerator(),
    }
  }
}

export function instrumentInProcess<T>(handler: T, config: InProcessConfigOptions): T {
  if (config.scrubbing !== undefined) {
    configureLogfireApi({ scrubbing: config.scrubbing })
  }
  return baseInstrument(handler, getInProcessConfig(config)) as T
}

export function instrumentTail<T>(handler: T, config: TailConfigOptions): T {
  return baseInstrument(handler, getTailConfig(config)) as T
}

/**
 * Alias for `instrumentInProcess` to maintain compatibility with previous versions.
 */
export const instrument: typeof instrumentInProcess = instrumentInProcess

function postProcessAttributes(spans: ReadableSpan[]) {
  for (const span of spans) {
    for (const attrKey of Object.keys(span.attributes)) {
      const attrVal = span.attributes[attrKey] as unknown
      if (attrVal === undefined || attrVal === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete span.attributes[attrKey]
      }
    }
    Object.assign(span.attributes, serializeAttributes(span.attributes))
  }
  return spans
}

const defaultExport: {
  exportTailEventsToLogfire: typeof exportTailEventsToLogfire
  Level: typeof Level
  LogfireAttributeScrubber: typeof LogfireAttributeScrubber
  NoopAttributeScrubber: typeof NoopAttributeScrubber
  ULIDGenerator: typeof ULIDGenerator
  configureLogfireApi: typeof configureLogfireApi
  debug: typeof debug
  error: typeof error
  fatal: typeof fatal
  getTailConfig: typeof getTailConfig
  info: typeof info
  instrument: typeof instrument
  instrumentInProcess: typeof instrumentInProcess
  instrumentTail: typeof instrumentTail
  log: typeof log
  logfireApiConfig: typeof logfireApiConfig
  notice: typeof notice
  reportError: typeof reportError
  resolveBaseUrl: typeof resolveBaseUrl
  resolveSendToLogfire: typeof resolveSendToLogfire
  serializeAttributes: typeof serializeAttributes
  span: typeof span
  startSpan: typeof startSpan
  trace: typeof trace
  warning: typeof warning
} = {
  exportTailEventsToLogfire,
  configureLogfireApi,
  debug,
  error,
  fatal,
  getTailConfig,
  info,
  instrument,
  instrumentInProcess,
  instrumentTail,
  // Re-export all from logfire
  Level,
  log,
  logfireApiConfig,
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  span,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
}

export default defaultExport
