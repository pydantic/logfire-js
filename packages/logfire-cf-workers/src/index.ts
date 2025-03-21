import type { OTLPExporterConfig, PostProcessorFn } from '@microlabs/otel-cf-workers'

import { ReadableSpan } from '@opentelemetry/sdk-trace-base'

export interface CloudflareConfigOptions {
  baseUrl?: string
  token: string
}

const DEFAULT_LOGFIRE_BASE_URL = 'https://logfire-api.pydantic.dev/'

export function cloudflareExporterConfig({ baseUrl = DEFAULT_LOGFIRE_BASE_URL, token }: CloudflareConfigOptions): OTLPExporterConfig {
  if (!baseUrl.endsWith('/')) {
    baseUrl += '/'
  }
  return {
    headers: { Authorization: token },
    url: `${baseUrl}v1/traces`,
  }
}

export function filterEmptyAttributes(spans: ReadableSpan[]) {
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

export function tracerConfig(env: { LOGFIRE_BASE_URL?: string; LOGFIRE_TOKEN: string }): {
  exporter: OTLPExporterConfig
  postProcessor: PostProcessorFn
} {
  const { LOGFIRE_BASE_URL: baseUrl = DEFAULT_LOGFIRE_BASE_URL, LOGFIRE_TOKEN: token } = env
  return {
    exporter: cloudflareExporterConfig({ baseUrl, token }),
    postProcessor: filterEmptyAttributes,
  }
}
