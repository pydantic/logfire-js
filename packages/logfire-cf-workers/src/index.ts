import { type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfireApi from '@pydantic/logfire-api'
import { resolveBaseUrl, serializeAttributes, ULIDGenerator } from '@pydantic/logfire-api'
import { instrument as baseInstrument, TraceConfig } from '@pydantic/otel-cf-workers'

import { LogfireCloudflareConsoleSpanExporter } from './LogfireCloudflareConsoleSpanExporter'
import { TailWorkerExporter } from './TailWorkerExporter'
export * from './exportTailEventsToLogfire'

type Env = Record<string, string | undefined>

type ConfigOptionsBase = Pick<
  TraceConfig,
  'environment' | 'fetch' | 'handlers' | 'instrumentation' | 'propagator' | 'sampling' | 'scope' | 'service'
>

export interface InProcessConfigOptions extends ConfigOptionsBase {
  baseUrl?: string
  /**
   * Whether to log the spans to the console in addition to sending them to the Logfire API.
   */
  console?: boolean
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | logfireApi.ScrubbingOptions
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TailConfigOptions extends ConfigOptionsBase {}

function getInProcessConfig(config: InProcessConfigOptions): (env: Env) => TraceConfig {
  return (env: Env): TraceConfig => {
    const { LOGFIRE_ENVIRONMENT: envDeploymentEnvironment, LOGFIRE_TOKEN: token = '' } = env

    const baseUrl = resolveBaseUrl(env, config.baseUrl, token)
    const resolvedEnvironment = config.environment ?? envDeploymentEnvironment

    const additionalSpanProcessors = config.console ? [new SimpleSpanProcessor(new LogfireCloudflareConsoleSpanExporter())] : []

    return Object.assign({}, config, {
      additionalSpanProcessors,
      environment: resolvedEnvironment,
      exporter: {
        headers: { Authorization: token },
        url: `${baseUrl}/v1/traces`,
      },
      idGenerator: new ULIDGenerator(),
      postProcessor: (spans: ReadableSpan[]) => postProcessAttributes(spans),
    }) satisfies TraceConfig
  }
}

export function getTailConfig(config: TailConfigOptions): (env: Env) => TraceConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_env: Env): TraceConfig => {
    return Object.assign({}, config, {
      exporter: new TailWorkerExporter(),
      idGenerator: new ULIDGenerator(),
    })
  }
}

export function instrumentInProcess<T>(handler: T, config: InProcessConfigOptions): T {
  if (config.scrubbing !== undefined) {
    logfireApi.configureLogfireApi({ scrubbing: config.scrubbing })
  }
  return baseInstrument(handler, getInProcessConfig(config)) as T
}

export function instrumentTail<T>(handler: T, config: TailConfigOptions): T {
  return baseInstrument(handler, getTailConfig(config)) as T
}

/**
 * Alias for `instrumentInProcess` to maintain compatibility with previous versions.
 */
export const instrument = instrumentInProcess

function postProcessAttributes(spans: ReadableSpan[]) {
  for (const span of spans) {
    for (const attrKey of Object.keys(span.attributes)) {
      const attrVal = span.attributes[attrKey]
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (attrVal === undefined || attrVal === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete span.attributes[attrKey]
      }
    }
    Object.assign(span.attributes, serializeAttributes(span.attributes))
  }
  return spans
}
