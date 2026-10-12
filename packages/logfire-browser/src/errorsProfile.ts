import { SpanStatusCode } from '@opentelemetry/api'
import type { TailSamplingSpanInfo } from 'logfire'

export type FrontendProfile = 'errors'

/**
 * Tail sampling rule of the `errors` profile: keep a trace when one of its spans failed.
 *
 * The default HTTP semantic conventions of the fetch and XHR instrumentations do not set an error
 * status on a 5xx response, so the response status code is checked as well.
 */
export function keepFailedTraces(info: TailSamplingSpanInfo): number {
  if (info.level.gte('error') || info.span.status.code === SpanStatusCode.ERROR) {
    return 1
  }
  const statusCode = info.span.attributes['http.response.status_code'] ?? info.span.attributes['http.status_code']
  return typeof statusCode === 'number' && statusCode >= 500 ? 1 : 0
}
