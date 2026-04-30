import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import type { PeriodicExportingMetricReaderOptions, PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

import { logfireConfig } from './logfireConfig'
import { VoidMetricExporter } from './VoidMetricExporter'

export type PeriodicMetricReaderOptions = Omit<PeriodicExportingMetricReaderOptions, 'exporter'>

export function metricExporter(): PushMetricExporter {
  if (!logfireConfig.sendToLogfire) {
    return new VoidMetricExporter()
  }

  const token = logfireConfig.token
  if (token === undefined || token === '') {
    throw new Error('Logfire token is required')
  }
  return new OTLPMetricExporter({
    headers: logfireConfig.authorizationHeaders,
    url: logfireConfig.metricExporterUrl,
  })
}

export function periodicMetricReader(options?: PeriodicMetricReaderOptions): PeriodicExportingMetricReader {
  return new PeriodicExportingMetricReader({
    exporter: metricExporter(),
    ...options,
  })
}
