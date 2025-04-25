import { ExportResult, ExportResultCode } from '@opentelemetry/core'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

import { IExportTraceServiceRequest, IKeyValue } from './OtlpTransformerTypes'

export class TailWorkerExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this._sendSpans(spans, resultCallback)
  }

  shutdown(): Promise<void> {
    this._sendSpans([])
    return Promise.resolve()
  }

  private _cleanNullValues(message: IExportTraceServiceRequest) {
    if (!message.resourceSpans) {
      return message
    }
    for (const resourceSpan of message.resourceSpans) {
      removeEmptyAttributes(resourceSpan.resource)
      for (const scopeSpan of resourceSpan.scopeSpans) {
        if (scopeSpan.scope) {
          removeEmptyAttributes(scopeSpan.scope)
        }

        for (const span of scopeSpan.spans ?? []) {
          removeEmptyAttributes(span)
        }
      }
    }
    return message
  }

  private _sendSpans(spans: ReadableSpan[], done?: (result: ExportResult) => void): void {
    const bytes = JsonTraceSerializer.serializeRequest(spans)
    const jsonString = new TextDecoder().decode(bytes)
    const response = JSON.parse(jsonString) as IExportTraceServiceRequest

    const exportMessage = this._cleanNullValues(response)

    console.log(exportMessage)

    return done?.({ code: ExportResultCode.SUCCESS })
  }
}

function removeEmptyAttributes(obj?: { attributes?: IKeyValue[] | undefined }) {
  if (obj?.attributes) {
    obj.attributes = obj.attributes.filter(nonEmptyAttribute)
  }
}

function nonEmptyAttribute(attribute: IKeyValue) {
  return Object.keys(attribute.value).length > 0
}
