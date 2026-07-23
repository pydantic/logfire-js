import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OTLPExporterConfig } from '../src/exporter'
import { OTLP_EXPORTER_USER_AGENT, OTLPExporter } from '../src/exporter'

const { version: packageVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const expectedDefaultUserAgent = `otel-cf-workers/${packageVersion}`

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

  it('prepends a lowercase user-agent header to the default identifier', async () => {
    expect(await exportedHeaders({ url: 'https://example.com/v1/traces', headers: { 'user-agent': 'custom/1.0' } })).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': `custom/1.0 ${OTLP_EXPORTER_USER_AGENT}`,
    })
  })

  it('prepends a capitalized User-Agent header without duplicating the key', async () => {
    expect(await exportedHeaders({ url: 'https://example.com/v1/traces', headers: { 'User-Agent': 'custom/1.0' } })).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': `custom/1.0 ${OTLP_EXPORTER_USER_AGENT}`,
    })
  })

  it('gives the userAgent option precedence over a User-Agent header', async () => {
    expect(
      await exportedHeaders({
        url: 'https://example.com/v1/traces',
        headers: { 'User-Agent': 'header/1.0' },
        userAgent: 'option/1.0',
      })
    ).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': `option/1.0 ${OTLP_EXPORTER_USER_AGENT}`,
    })
  })
})
