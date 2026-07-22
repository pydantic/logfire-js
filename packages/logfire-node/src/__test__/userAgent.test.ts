import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

// Mirror the PACKAGE_VERSION define from vite.config.ts so the expected value
// matches what Vite substituted at test-compile time, regardless of whether
// npm_package_version is populated in the current shell.
const expectedUserAgent = `logfire-js/${process.env['npm_package_version'] ?? '0.0.0'}`

describe('User-Agent', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('@opentelemetry/exporter-logs-otlp-proto')
    vi.doUnmock('@opentelemetry/exporter-metrics-otlp-proto')
    vi.doUnmock('@opentelemetry/exporter-trace-otlp-proto')
  })

  it('USER_AGENT constant equals logfire-js/<package-version>', async () => {
    const { USER_AGENT } = await import('../logfireConfig')
    expect(USER_AGENT).toBe(expectedUserAgent)
  })

  it('traceExporter passes userAgent to OTLPTraceExporter', async () => {
    const OTLPTraceExporterMock = vi.fn<(options: Record<string, unknown>) => void>()

    vi.doMock('@opentelemetry/exporter-trace-otlp-proto', () => ({
      OTLPTraceExporter: OTLPTraceExporterMock,
    }))

    const { logfireConfig } = await import('../logfireConfig')
    Object.assign(logfireConfig, {
      authorizationHeaders: { Authorization: 'test-token' },
      sendToLogfire: true,
      token: 'test-token',
      traceExporterUrl: 'https://logfire-api.pydantic.dev/v1/traces',
    })

    const { traceExporter } = await import('../traceExporter')
    traceExporter()

    expect(OTLPTraceExporterMock).toHaveBeenCalledOnce()
    expect(OTLPTraceExporterMock).toHaveBeenCalledWith({
      headers: { Authorization: 'test-token' },
      url: 'https://logfire-api.pydantic.dev/v1/traces',
      userAgent: expectedUserAgent,
    })
  })

  it('metricExporter passes userAgent to OTLPMetricExporter', async () => {
    const OTLPMetricExporterMock = vi.fn<(options: Record<string, unknown>) => void>()

    vi.doMock('@opentelemetry/exporter-metrics-otlp-proto', () => ({
      OTLPMetricExporter: OTLPMetricExporterMock,
    }))

    const { logfireConfig } = await import('../logfireConfig')
    Object.assign(logfireConfig, {
      authorizationHeaders: { Authorization: 'test-token' },
      metricExporterUrl: 'https://logfire-api.pydantic.dev/v1/metrics',
      sendToLogfire: true,
      token: 'test-token',
    })

    const { metricExporter } = await import('../metricExporter')
    metricExporter()

    expect(OTLPMetricExporterMock).toHaveBeenCalledOnce()
    expect(OTLPMetricExporterMock).toHaveBeenCalledWith({
      headers: { Authorization: 'test-token' },
      url: 'https://logfire-api.pydantic.dev/v1/metrics',
      userAgent: expectedUserAgent,
    })
  })

  it('logfireLogRecordProcessor passes userAgent to OTLPLogExporter', async () => {
    const OTLPLogExporterMock = vi.fn<(options: Record<string, unknown>) => void>()

    vi.doMock('@opentelemetry/exporter-logs-otlp-proto', () => ({
      OTLPLogExporter: OTLPLogExporterMock,
    }))

    const { logfireConfig } = await import('../logfireConfig')
    Object.assign(logfireConfig, {
      authorizationHeaders: { Authorization: 'test-token' },
      logsExporterUrl: 'https://logfire-api.pydantic.dev/v1/logs',
      sendToLogfire: true,
      token: 'test-token',
    })

    const { logfireLogRecordProcessor } = await import('../logsExporter')
    logfireLogRecordProcessor()

    expect(OTLPLogExporterMock).toHaveBeenCalledOnce()
    expect(OTLPLogExporterMock).toHaveBeenCalledWith({
      headers: { Authorization: 'test-token' },
      url: 'https://logfire-api.pydantic.dev/v1/logs',
      userAgent: expectedUserAgent,
    })
  })
})
