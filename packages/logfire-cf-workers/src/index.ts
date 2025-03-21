import { KVNamespace } from '@cloudflare/workers-types'
import { instrument as microlabsInstrument } from '@microlabs/otel-cf-workers'
import { ReadableSpan } from '@opentelemetry/sdk-trace-base'

export interface CloudflareConfigOptions {
  baseUrl?: string
  token: string
}

interface Env {
  LOGFIRE_BASE_URL: string
  LOGFIRE_TOKEN: string
  OTEL_TEST: KVNamespace
}

export interface LogfireCloudflareConfigOptions {
  serviceName?: string
  serviceNamespace?: string
  serviceVersion?: string
}

const DEFAULT_LOGFIRE_BASE_URL = 'https://logfire-api.pydantic.dev/'

function getConfig(config: LogfireCloudflareConfigOptions) {
  return (env: Env) => {
    let { LOGFIRE_BASE_URL: baseUrl = DEFAULT_LOGFIRE_BASE_URL, LOGFIRE_TOKEN: token } = env

    if (!baseUrl.endsWith('/')) {
      baseUrl += '/'
    }

    return {
      exporter: {
        headers: { Authorization: token },
        url: `${baseUrl}v1/traces`,
      },
      postProcessor: filterEmptyAttributes,
      service: {
        name: config.serviceName ?? 'cloudflare-worker',
        namespace: config.serviceNamespace ?? '',
        version: config.serviceVersion ?? '0.0.0',
      },
    }
  }
}

export function instrument<T>(handler: T, config: LogfireCloudflareConfigOptions): T {
  return microlabsInstrument(handler, getConfig(config))
}

// ATM this is broken in microlabs,
/*
function instrumentDO<T>(doClass: T, config: LogfireCloudflareConfigOptions): T {
  // the d.ts bundler choked on this
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
  return microlabsInstrumentDO(doClass as unknown as any, getConfig(config)) as T
}
*/

function filterEmptyAttributes(spans: ReadableSpan[]) {
  for (const span of spans) {
    for (const attrKey of Object.keys(span.attributes)) {
      const attrVal = span.attributes[attrKey]
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (attrVal === undefined || attrVal === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete span.attributes[attrKey]
      }
    }
  }
  return spans
}
