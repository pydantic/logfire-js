import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { resolveBaseUrl, serializeAttributes, ULIDGenerator } from '@pydantic/logfire-api'
import { instrument as baseInstrument, TraceConfig } from '@pydantic/otel-cf-workers'

import { TailWorkerExporter } from './TailWorkerExporter'
export * from './exportTailEventsToLogfire'

export interface CloudflareConfigOptions {
  baseUrl?: string
  token: string
}

type Env = Record<string, string | undefined>

type ConfigOptionsBase = Pick<
  TraceConfig,
  'environment' | 'fetch' | 'handlers' | 'instrumentation' | 'propagator' | 'sampling' | 'scope' | 'service'
>

export interface InProcessConfigOptions extends ConfigOptionsBase {
  baseUrl?: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TailConfigOptions extends ConfigOptionsBase {}

function getInProcessConfig(config: InProcessConfigOptions): (env: Env) => TraceConfig {
  return (env: Env): TraceConfig => {
    const { LOGFIRE_ENVIRONMENT: envDeploymentEnvironment, LOGFIRE_TOKEN: token = '' } = env

    const baseUrl = resolveBaseUrl(env, config.baseUrl, token)
    const resolvedEnvironment = config.environment ?? envDeploymentEnvironment

    return Object.assign({}, config, {
      environment: resolvedEnvironment,
      exporter: {
        headers: { Authorization: token },
        url: `${baseUrl}/v1/traces`,
      },
      idGenerator: new ULIDGenerator(),
      postProcessor: (spans: ReadableSpan[]) => postProcessAttributes(spans),
    })
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
