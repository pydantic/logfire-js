import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import { OTLPExporterError } from '@opentelemetry/otlp-exporter-base'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { unwrap } from './wrap.js'

export interface OTLPExporterConfig {
  url: string
  headers?: Record<string, string>
  /**
   * Product identifier prepended to the exporter's default User-Agent,
   * following the OTLP recommendation that distributions retain the default
   * exporter identifier.
   */
  userAgent?: string
}

export const OTLP_EXPORTER_USER_AGENT: string = `otel-cf-workers/${PACKAGE_VERSION}`

const defaultHeaders: Record<string, string> = {
  accept: 'application/json',
  'content-type': 'application/json',
}

export class OTLPExporter implements SpanExporter {
  private readonly headers: Record<string, string>
  private readonly url: string
  constructor(config: OTLPExporterConfig) {
    this.url = config.url
    const headers: Record<string, string> = {}
    let headerUserAgent: string | undefined
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (key.toLowerCase() === 'user-agent') {
        headerUserAgent = value
      } else {
        headers[key] = value
      }
    }
    const prefix = config.userAgent ?? headerUserAgent
    this.headers = {
      ...defaultHeaders,
      ...headers,
      'user-agent': prefix === undefined ? OTLP_EXPORTER_USER_AGENT : `${prefix} ${OTLP_EXPORTER_USER_AGENT}`,
    }
  }

  export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.exportItems(items)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error: toError(error) })
      })
  }

  private async exportItems(items: ReadableSpan[]): Promise<unknown> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.send(items, resolve, reject)
      } catch (error) {
        reject(toError(error))
      }
    })
  }

  send(items: ReadableSpan[], onSuccess: () => void, onError: (error: OTLPExporterError) => void): void {
    const decoder = new TextDecoder()
    const exportMessage = JsonTraceSerializer.serializeRequest(items)

    const body = decoder.decode(exportMessage)
    const params: RequestInit = {
      method: 'POST',
      headers: this.headers,
      body,
    }

    unwrap(fetch)(this.url, params)
      .then((response) => {
        if (response.ok) {
          onSuccess()
        } else {
          onError(new OTLPExporterError(`Exporter received a statusCode: ${String(response.status)}`))
        }
      })
      .catch((error) => {
        const err = toError(error)
        onError(new OTLPExporterError(`Exception during export: ${err.message}`, undefined, err.stack))
      })
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
