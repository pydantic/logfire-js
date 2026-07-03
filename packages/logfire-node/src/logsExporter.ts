import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import type { LogRecordExporter, LogRecordProcessor } from '@opentelemetry/sdk-logs'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'

import { logfireConfig } from './logfireConfig'

type BatchLogRecordProcessorConstructor = {
  legacy: new (exporter: LogRecordExporter) => LogRecordProcessor
  options: new (options: { exporter: LogRecordExporter }) => LogRecordProcessor
}

export function makeBatchLogRecordProcessor(exporter: LogRecordExporter): LogRecordProcessor {
  const Constructor = BatchLogRecordProcessor as unknown as BatchLogRecordProcessorConstructor['legacy'] &
    BatchLogRecordProcessorConstructor['options']
  const BaseConstructor = Object.getPrototypeOf(BatchLogRecordProcessor) as { readonly length: number } | null

  // @opentelemetry/sdk-logs changed the constructor from `(exporter, config?)`
  // to `({ exporter, ...config })` in 0.220. Support both shapes because our
  // peer range deliberately spans the experimental 0.x logs package.
  if (BaseConstructor?.length === 2) {
    return new Constructor(exporter)
  }

  return new Constructor({ exporter })
}

/**
 * Returns a `BatchLogRecordProcessor` wired to the Logfire OTLP /v1/logs endpoint.
 * Used by `withOnlineEvaluation` to ship `gen_ai.evaluation.result` log events.
 *
 * Returns null when sendToLogfire is disabled — the OTel API logs methods will
 * become no-ops.
 */
export function logfireLogRecordProcessor(): LogRecordProcessor | null {
  const token = logfireConfig.token
  if (!logfireConfig.sendToLogfire || !(typeof token === 'function' || (token !== undefined && token !== ''))) {
    return null
  }
  return makeBatchLogRecordProcessor(
    new OTLPLogExporter({
      headers: logfireConfig.authorizationHeaders,
      url: logfireConfig.logsExporterUrl,
    })
  )
}
