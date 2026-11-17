import { diag } from '@opentelemetry/api'

export type TraceRecoveryResult = 'success' | 'permanent-failure' | 'retryable-failure'

/** One background attempt; transient failures stay in storage for a later document. */
export async function recoverTraceRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMillis: number,
  lifecycle: AbortSignal
): Promise<TraceRecoveryResult> {
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
  }
  lifecycle.addEventListener('abort', abort, { once: true })
  if (lifecycle.aborted) {
    controller.abort()
  }
  const timer = setTimeout(abort, timeoutMillis)
  try {
    const instrumented = globalThis.fetch as typeof fetch & { __original?: typeof fetch }
    // OpenTelemetry exposes the original transport to avoid tracing exporter requests.
    // eslint-disable-next-line no-underscore-dangle
    const fetchApi = typeof instrumented.__original === 'function' ? instrumented.__original : instrumented
    const requestHeaders = new Headers(headers)
    requestHeaders.set('content-type', 'application/json')
    const response = await fetchApi(url, {
      method: 'POST',
      body,
      headers: requestHeaders,
      signal: controller.signal,
      // Recovery runs in a live document and must not compete with unload traffic for keepalive quota.
      keepalive: false,
    })
    // Release the connection even when the collector returns an error body.
    await response.body?.cancel().catch(() => undefined)
    if (response.ok) {
      return 'success'
    }
    const retryable = [408, 429, 500, 502, 503, 504].includes(response.status)
    diag.warn(`logfire-browser: trace recovery returned HTTP ${String(response.status)}; ${retryable ? 'retaining' : 'discarding'} request`)
    return retryable ? 'retryable-failure' : 'permanent-failure'
  } catch (error) {
    if (!lifecycle.aborted) {
      diag.warn('logfire-browser: trace recovery failed; retaining request', error)
    }
    return 'retryable-failure'
  } finally {
    clearTimeout(timer)
    lifecycle.removeEventListener('abort', abort)
  }
}
