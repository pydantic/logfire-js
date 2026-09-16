import { describe, expect, it } from 'vite-plus/test'

import { createFrontendApplicationConfig } from './index'

describe('createFrontendApplicationConfig', () => {
  it('derives every browser transport from one deployment and token', async () => {
    const load = async () => import('@pydantic/logfire-session-replay')
    const config = createFrontendApplicationConfig({
      baseUrl: 'https://logfire-eu.pydantic.dev',
      sessionReplay: { load },
      token: 'pylf_v1_eu_public',
    })

    expect(config.traceUrl).toBe('https://logfire-eu.pydantic.dev/v1/traces')
    expect(config.traceExporterHeaders?.()).toEqual({ Authorization: 'Bearer pylf_v1_eu_public' })
    const metrics = config.metrics
    if (metrics === undefined || metrics === false) {
      throw new Error('expected frontend metrics configuration')
    }
    expect(metrics).toMatchObject({ metricUrl: 'https://logfire-eu.pydantic.dev/v1/metrics' })
    expect(await metrics.metricExporterHeaders?.()).toEqual({
      Authorization: 'Bearer pylf_v1_eu_public',
    })
    expect(config.autoInstrumentations).toBeUndefined()
    expect(config.rum).toBeUndefined()
    const sessionReplay = config.sessionReplay
    if (sessionReplay === undefined || sessionReplay === false) {
      throw new Error('expected session replay configuration')
    }
    expect(sessionReplay.replayUrl).toBe('https://logfire-eu.pydantic.dev/v1/replay')
    expect(sessionReplay.load).toBe(load)
    expect(sessionReplay.headers?.()).toEqual({
      Authorization: 'Bearer pylf_v1_eu_public',
    })
  })

  it('keeps replay disabled unless requested', () => {
    const config = createFrontendApplicationConfig({
      baseUrl: 'http://localhost:3000',
      token: 'local-public-token',
    })

    expect(config.sessionReplay).toBeUndefined()
  })

  it('applies replay capture overrides without allowing transport overrides', () => {
    const load = async () => import('@pydantic/logfire-session-replay')
    const config = createFrontendApplicationConfig({
      baseUrl: 'https://logfire-us.pydantic.dev/',
      sessionReplay: { load, maskAllText: false, sessionSampleRate: 0.25 },
      token: 'pylf_v1_us_public',
    })

    expect(config.sessionReplay).toMatchObject({
      maskAllText: false,
      load,
      replayUrl: 'https://logfire-us.pydantic.dev/v1/replay',
      sessionSampleRate: 0.25,
    })
  })

  it.each([
    [{ baseUrl: 'https://logfire-us.pydantic.dev', token: '' }, 'token must not be empty'],
    [{ baseUrl: 'ftp://logfire.example.com', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
    [{ baseUrl: 'https://logfire.example.com?region=us', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
    [{ baseUrl: 'https://logfire.example.com/tenant', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
    [{ baseUrl: 'not a URL', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
  ] as const)('rejects invalid frontend application configuration', (options, message) => {
    expect(() => createFrontendApplicationConfig(options)).toThrow(message)
  })
})
