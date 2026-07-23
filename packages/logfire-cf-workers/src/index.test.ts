import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { instrument as instrumentFunction, startPendingSpan, withSettings, withTags } from 'logfire'
import * as packageRoot from '@pydantic/logfire-cf-workers'

import logfireCfWorkers, { instrument as instrumentWorker } from './index'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, Record<string, string>>
  version: string
}

describe('cf-workers default export', () => {
  it('keeps instrument as the Cloudflare runtime helper', () => {
    const defaultInstrument = Object.getOwnPropertyDescriptor(logfireCfWorkers, 'instrument')?.value as typeof instrumentWorker

    expect(defaultInstrument).toBe(instrumentWorker)
    expect(defaultInstrument).not.toBe(instrumentFunction)
  })

  it('re-exports startPendingSpan from the shared API', () => {
    expect(logfireCfWorkers.startPendingSpan).toBe(startPendingSpan)
  })

  it('mirrors scoped client helpers on the default export', () => {
    expect(logfireCfWorkers.withSettings).toBe(withSettings)
    expect(logfireCfWorkers.withTags).toBe(withTags)
  })

  it('publishes esm-only package metadata', () => {
    expect(packageRoot.instrument).toBeTypeOf('function')
    expect(packageRoot.instrumentDO).toBeTypeOf('function')
    expect(packageRoot.default.instrument).toBe(packageRoot.instrument)
    expect(packageRoot.default.instrumentDO).toBe(packageRoot.instrumentDO)
    expect(packageJson.exports['.']).not.toHaveProperty('require')
    expect(packageJson.exports['.']?.['default']).toBe('./dist/index.js')
    expect(packageJson.exports['.']?.['types']).toBe('./dist/index.d.ts')
    expect(readdirSync(new URL('../dist', import.meta.url)).sort()).toEqual(['index.d.ts', 'index.js'])
  })
})

const expectedUserAgent = `logfire-js/${packageJson.version}`

describe('User-Agent', () => {
  afterEach(() => {
    vi.doUnmock('@pydantic/otel-cf-workers')
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('USER_AGENT constant equals logfire-js/<package-version>', async () => {
    vi.resetModules()
    const { USER_AGENT } = await import('./userAgent')
    expect(USER_AGENT).toBe(expectedUserAgent)
  })

  it('in-process exporter config prepends the logfire-js user agent', async () => {
    vi.resetModules()

    type InProcessConfigFn = (env: Record<string, string | undefined>) => {
      exporter: { headers: Record<string, string>; url: string; userAgent: string }
    }

    let capturedConfigFn: InProcessConfigFn | undefined

    vi.doMock('@pydantic/otel-cf-workers', () => ({
      instrument: (handler: unknown, configFn: InProcessConfigFn): unknown => {
        capturedConfigFn = configFn
        return handler
      },
      instrumentDO: (doClass: unknown): unknown => doClass,
      OTLP_EXPORTER_USER_AGENT: 'otel-cf-workers/0.0.0',
    }))

    const [{ instrumentInProcess }, { USER_AGENT }] = await Promise.all([import('./index'), import('./userAgent')])

    instrumentInProcess({}, { service: { name: 'test-service' } })

    expect(capturedConfigFn).toBeDefined()
    const config = capturedConfigFn?.({ LOGFIRE_TOKEN: 'test-token' })
    expect(config?.exporter).toEqual({
      headers: { Authorization: 'test-token' },
      url: 'https://logfire-us.pydantic.dev/v1/traces',
      userAgent: USER_AGENT,
    })
  })

  it('exportTailEventsToLogfire sends the two-product User-Agent header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    vi.resetModules()
    const [{ exportTailEventsToLogfire }, { USER_AGENT }, { OTLP_EXPORTER_USER_AGENT }] = await Promise.all([
      import('./exportTailEventsToLogfire'),
      import('./userAgent'),
      import('@pydantic/otel-cf-workers'),
    ])

    const events = [{ logs: [{ message: [{ resourceSpans: [] }] }] }]
    await exportTailEventsToLogfire(events, { LOGFIRE_TOKEN: 'test-token' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.lastCall?.[0]).toBe('https://logfire-us.pydantic.dev/v1/traces')
    expect(fetchMock.mock.lastCall?.[1]).toEqual({
      body: JSON.stringify({ resourceSpans: [] }),
      headers: {
        Authorization: 'test-token',
        'Content-Type': 'application/json',
        'User-Agent': `${USER_AGENT} ${OTLP_EXPORTER_USER_AGENT}`,
      },
      method: 'POST',
    })
  })
})
