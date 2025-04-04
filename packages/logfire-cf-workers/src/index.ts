import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { instrument as microlabsInstrument } from '@microlabs/otel-cf-workers'
import { resolveBaseUrl, serializeAttributes } from '@pydantic/logfire-api'

export interface CloudflareConfigOptions {
  baseUrl?: string
  token: string
}

type Env = Record<string, string | undefined>

export interface LogfireCloudflareConfigOptions {
  baseUrl?: string
  serviceName?: string
  serviceNamespace?: string
  serviceVersion?: string
}

function getConfig(config: LogfireCloudflareConfigOptions) {
  return (env: Env) => {
    const { LOGFIRE_TOKEN: token = '' } = env

    const baseUrl = resolveBaseUrl(env, config.baseUrl, token)

    return {
      exporter: {
        headers: { Authorization: token },
        url: `${baseUrl}/v1/traces`,
      },
      postProcessor: (spans: ReadableSpan[]) => postProcessAttributes(spans),
      service: {
        name: config.serviceName ?? 'cloudflare-worker',
        namespace: config.serviceNamespace ?? '',
        version: config.serviceVersion ?? '0.0.0',
      },
    }
  }
}

export function instrument<T>(handler: T, config: LogfireCloudflareConfigOptions): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
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
