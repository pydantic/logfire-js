import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OTLPExporterConfig } from '../src/exporter'
import { OTLP_EXPORTER_USER_AGENT, OTLPExporter } from '../src/exporter'

// Mirror the PACKAGE_VERSION define from vite.config.ts so the expected value
// matches what Vite substituted at test-compile time, regardless of whether
// npm_package_version is populated in the current shell.
const expectedDefaultUserAgent = `otel-cf-workers/${process.env.npm_package_version ?? '0.0.0'}`

async function exportedHeaders(config: OTLPExporterConfig): Promise<unknown> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
  vi.stubGlobal('fetch', fetchMock)

  const exporter = new OTLPExporter(config)
  await new Promise<void>((resolve, reject) => {
    exporter.export([], (result) => {
      if (result.error) {
        reject(result.error)
      } else {
        resolve()
      }
    })
  })

  return fetchMock.mock.lastCall?.[1]?.headers
}

describe('OTLPExporter user agent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('OTLP_EXPORTER_USER_AGENT equals otel-cf-workers/<package-version>', () => {
    expect(OTLP_EXPORTER_USER_AGENT).toBe(expectedDefaultUserAgent)
  })

  it('sends the default exporter identifier when no userAgent is configured', async () => {
    expect(await exportedHeaders({ url: 'https://example.com/v1/traces' })).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': OTLP_EXPORTER_USER_AGENT,
    })
  })

  it('prepends the configured userAgent to the default identifier', async () => {
    expect(await exportedHeaders({ url: 'https://example.com/v1/traces', userAgent: 'logfire-js/1.2.3' })).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': `logfire-js/1.2.3 ${OTLP_EXPORTER_USER_AGENT}`,
    })
  })
})
