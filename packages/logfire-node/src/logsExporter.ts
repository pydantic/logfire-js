import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'

import { logfireConfig } from './logfireConfig'

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
  return new BatchLogRecordProcessor(
    new OTLPLogExporter({
      headers: logfireConfig.authorizationHeaders,
      url: logfireConfig.logsExporterUrl,
    })
  )
}
