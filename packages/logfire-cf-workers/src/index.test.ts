import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { instrument as instrumentFunction, startPendingSpan, withSettings, withTags } from 'logfire'
import * as packageRoot from '@pydantic/logfire-cf-workers'

import logfireCfWorkers, { instrument as instrumentWorker } from './index'

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
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, Record<string, string>>
    }

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

// Mirror the PACKAGE_VERSION define from vite.config.ts so the expected value
// matches what Vite substituted at test-compile time, regardless of whether
// npm_package_version is populated in the current shell.
const expectedUserAgent = `logfire-js/${process.env['npm_package_version'] ?? '0.0.0'}`

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

  it('in-process exporter config includes User-Agent header', async () => {
    vi.resetModules()

    type InProcessConfigFn = (env: Record<string, string | undefined>) => {
      exporter: { headers: Record<string, string>; url: string }
    }

    let capturedConfigFn: InProcessConfigFn | undefined

    vi.doMock('@pydantic/otel-cf-workers', () => ({
      instrument: (handler: unknown, configFn: InProcessConfigFn): unknown => {
        capturedConfigFn = configFn
        return handler
      },
      instrumentDO: (doClass: unknown): unknown => doClass,
    }))

    const [{ instrumentInProcess }, { USER_AGENT }] = await Promise.all([import('./index'), import('./userAgent')])

    instrumentInProcess({}, { service: { name: 'test-service' } })

    expect(capturedConfigFn).toBeDefined()
    const config = capturedConfigFn?.({ LOGFIRE_TOKEN: 'test-token' })
    expect(config?.exporter.headers['User-Agent']).toBe(USER_AGENT)
  })

  it('exportTailEventsToLogfire sends User-Agent header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    vi.resetModules()
    const [{ exportTailEventsToLogfire }, { USER_AGENT }] = await Promise.all([
      import('./exportTailEventsToLogfire'),
      import('./userAgent'),
    ])

    const events = [{ logs: [{ message: [{ resourceSpans: [] }] }] }]
    await exportTailEventsToLogfire(events, { LOGFIRE_TOKEN: 'test-token' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0]
    if (!call) {
      throw new Error('fetch was not called')
    }
    expect(call[1]).toMatchObject({ headers: { 'User-Agent': USER_AGENT } })
  })
})
