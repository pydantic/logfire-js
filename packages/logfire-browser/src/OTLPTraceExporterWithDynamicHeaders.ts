import {
  getSharedConfigurationDefaults,
  mergeOtlpSharedConfigurationWithDefaults,
  OTLPExporterBase,
  OTLPExporterNodeConfigBase,
} from '@opentelemetry/otlp-exporter-base'
import { createOtlpXhrExportDelegate } from '@opentelemetry/otlp-exporter-base/browser-http'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'

// https://github.com/open-telemetry/opentelemetry-js/pull/3662#issuecomment-2262808849
export class OTLPTraceExporterWithDynamicHeaders extends OTLPExporterBase<ReadableSpan[]> implements SpanExporter {
  constructor(config: OTLPExporterNodeConfigBase, getHeaders?: () => Record<string, string>) {
    const sharedConfig = mergeOtlpSharedConfigurationWithDefaults(
      {
        compression: config.compression,
        concurrencyLimit: config.concurrencyLimit,
        timeoutMillis: config.timeoutMillis,
      },
      {},
      getSharedConfigurationDefaults()
    )

    const xhrExportConfig = {
      ...sharedConfig,
      agentOptions: { keepAlive: true },
      headers: async () => {
        const configHeaders = typeof config.headers === 'function' ? await config.headers() : (config.headers ?? {})
        return {
          'Content-Type': 'application/json',
          ...configHeaders,
          ...(getHeaders?.() ?? {}),
        }
      },
      url: config.url ?? 'http://localhost:4318/v1/traces',
    }

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- XHR is still supported for browser compatibility
    super(createOtlpXhrExportDelegate(xhrExportConfig, JsonTraceSerializer))
  }
}
