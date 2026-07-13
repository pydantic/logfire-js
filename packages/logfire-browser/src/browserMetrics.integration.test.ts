import { resourceFromAttributes } from '@opentelemetry/resources'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { startBrowserMetrics } from './browserMetrics'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser metrics exporter boundary', () => {
  it('contains synchronously thrown headers without issuing an unauthenticated request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Promise.resolve(new Response(null, { status: 202 })))
    vi.stubGlobal('fetch', fetchImpl)
    const runtime = await startBrowserMetrics(
      {
        metricExporterHeaders: () => {
          throw new Error('metric headers unavailable')
        },
        metricReaderConfig: { exportIntervalMillis: 60_000, exportTimeoutMillis: 1_000 },
        metricUrl: 'https://metrics.example/v1/metrics',
      },
      resourceFromAttributes({ 'service.name': 'browser-metrics-test' })
    )

    runtime.createWebVitalsMetricRecorder().record({ name: 'FCP', rating: 'good', value: 123 } as never)
    await expect(runtime.forceFlush()).resolves.toBeUndefined()
    await runtime.shutdown()

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('contains rejected headers without issuing an unauthenticated request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Promise.resolve(new Response(null, { status: 202 })))
    vi.stubGlobal('fetch', fetchImpl)
    const headerError = new Error('metric headers unavailable')
    const runtime = await startBrowserMetrics(
      {
        metricExporterHeaders: async () => Promise.reject(headerError),
        metricReaderConfig: { exportIntervalMillis: 60_000, exportTimeoutMillis: 1_000 },
        metricUrl: 'https://metrics.example/v1/metrics',
      },
      resourceFromAttributes({ 'service.name': 'browser-metrics-test' })
    )

    runtime.createWebVitalsMetricRecorder().record({ name: 'FCP', rating: 'good', value: 123 } as never)
    await expect(runtime.forceFlush()).resolves.toBeUndefined()
    await runtime.shutdown()

    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
