import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { configureLogfireApi, Level, logfireApiConfig } from 'logfire'
import { shutdownVariables } from 'logfire/vars'

import { configure, logfireConfig } from '../logfireConfig'

vi.mock('../sdk', () => ({
  start: vi.fn<() => void>(),
}))

describe('logfire config', () => {
  const originalApiKey = process.env['LOGFIRE_API_KEY']
  const originalBaseUrl = process.env['LOGFIRE_BASE_URL']
  const originalConsole = process.env['LOGFIRE_CONSOLE']
  const originalMinLevel = process.env['LOGFIRE_MIN_LEVEL']
  const originalSendToLogfire = process.env['LOGFIRE_SEND_TO_LOGFIRE']
  const originalLogfireServiceName = process.env['LOGFIRE_SERVICE_NAME']
  const originalLogfireServiceVersion = process.env['LOGFIRE_SERVICE_VERSION']
  const originalOtelServiceName = process.env['OTEL_SERVICE_NAME']
  const originalOtelServiceVersion = process.env['OTEL_SERVICE_VERSION']
  const originalToken = process.env['LOGFIRE_TOKEN']

  beforeEach(async () => {
    process.env['LOGFIRE_API_KEY'] = ''
    delete process.env['LOGFIRE_BASE_URL']
    delete process.env['LOGFIRE_CONSOLE']
    delete process.env['LOGFIRE_MIN_LEVEL']
    delete process.env['LOGFIRE_SEND_TO_LOGFIRE']
    delete process.env['LOGFIRE_SERVICE_NAME']
    delete process.env['LOGFIRE_SERVICE_VERSION']
    delete process.env['OTEL_SERVICE_NAME']
    delete process.env['OTEL_SERVICE_VERSION']
    delete process.env['LOGFIRE_TOKEN']
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    await shutdownVariables()
  })

  afterEach(async () => {
    if (originalApiKey === undefined) {
      process.env['LOGFIRE_API_KEY'] = ''
    } else {
      process.env['LOGFIRE_API_KEY'] = originalApiKey
    }
    if (originalBaseUrl === undefined) {
      delete process.env['LOGFIRE_BASE_URL']
    } else {
      process.env['LOGFIRE_BASE_URL'] = originalBaseUrl
    }
    if (originalConsole === undefined) {
      delete process.env['LOGFIRE_CONSOLE']
    } else {
      process.env['LOGFIRE_CONSOLE'] = originalConsole
    }
    if (originalMinLevel === undefined) {
      delete process.env['LOGFIRE_MIN_LEVEL']
    } else {
      process.env['LOGFIRE_MIN_LEVEL'] = originalMinLevel
    }
    if (originalSendToLogfire === undefined) {
      delete process.env['LOGFIRE_SEND_TO_LOGFIRE']
    } else {
      process.env['LOGFIRE_SEND_TO_LOGFIRE'] = originalSendToLogfire
    }
    if (originalLogfireServiceName === undefined) {
      delete process.env['LOGFIRE_SERVICE_NAME']
    } else {
      process.env['LOGFIRE_SERVICE_NAME'] = originalLogfireServiceName
    }
    if (originalLogfireServiceVersion === undefined) {
      delete process.env['LOGFIRE_SERVICE_VERSION']
    } else {
      process.env['LOGFIRE_SERVICE_VERSION'] = originalLogfireServiceVersion
    }
    if (originalOtelServiceName === undefined) {
      delete process.env['OTEL_SERVICE_NAME']
    } else {
      process.env['OTEL_SERVICE_NAME'] = originalOtelServiceName
    }
    if (originalOtelServiceVersion === undefined) {
      delete process.env['OTEL_SERVICE_VERSION']
    } else {
      process.env['OTEL_SERVICE_VERSION'] = originalOtelServiceVersion
    }
    if (originalToken === undefined) {
      delete process.env['LOGFIRE_TOKEN']
    } else {
      process.env['LOGFIRE_TOKEN'] = originalToken
    }
    Object.assign(logfireConfig, {
      authorizationHeaders: {},
      baggage: {
        spanAttributes: [],
      },
      baseUrl: '',
      console: false,
      jsonSchema: 'rich',
      logsExporterUrl: '',
      metricExporterUrl: '',
      minLevel: undefined,
      resourceAttributes: {},
      sendToLogfire: false,
      serviceName: undefined,
      serviceVersion: undefined,
      token: '',
      traceExporterUrl: '',
    })
    configureLogfireApi({ baggage: { spanAttributes: [] }, jsonSchema: 'rich', minLevel: null })
    await shutdownVariables()
  })

  it('configures an explicit remote provider with apiKey', () => {
    configure({
      advanced: { baseUrl: 'https://example.com' },
      apiKey: 'lf-api-key',
      variables: {
        polling: false,
        sse: false,
      },
    })

    expect(logfireConfig.apiKey).toBe('lf-api-key')
    expect(logfireConfig.variables).toEqual({ polling: false, sse: false })
    expect(logfireConfig.variablesBaseUrl).toBe('https://example.com')
  })

  it('reads LOGFIRE_API_KEY for remote variables', () => {
    process.env['LOGFIRE_API_KEY'] = 'lf-env-api-key'

    configure({
      advanced: { baseUrl: 'https://example.com' },
      variables: {
        polling: false,
        sse: false,
      },
    })

    expect(logfireConfig.apiKey).toBe('lf-env-api-key')
    expect(logfireConfig.variables).toEqual({ polling: false, sse: false })
    expect(logfireConfig.variablesBaseUrl).toBe('https://example.com')
  })

  it('stores local and disabled variables config explicitly', () => {
    const localVariables = {
      config: {
        variables: {},
      },
    }
    configure({
      variables: localVariables,
    })
    expect(logfireConfig.variables).toBe(localVariables)

    configure({ variables: false })
    expect(logfireConfig.variables).toBe(false)
  })

  it('stores configured resource attributes', () => {
    const resourceAttributes = {
      'app.installation.id': 'install-123',
      'service.namespace': 'my-company',
    }

    configure({ resourceAttributes })

    expect(logfireConfig.resourceAttributes).toBe(resourceAttributes)
  })

  it('passes jsonSchema config to the shared API', () => {
    configure({ jsonSchema: 'basic' })

    expect(logfireApiConfig.jsonSchema).toBe('basic')
    expect(logfireConfig.jsonSchema).toBe('basic')
  })

  it('reads OTEL service metadata when Logfire-specific environment variables are omitted', () => {
    process.env['OTEL_SERVICE_NAME'] = 'otel-service'
    process.env['OTEL_SERVICE_VERSION'] = '1.2.3'

    configure()

    expect(logfireConfig.serviceName).toBe('otel-service')
    expect(logfireConfig.serviceVersion).toBe('1.2.3')
  })

  it('lets LOGFIRE service metadata override OTEL service metadata', () => {
    process.env['LOGFIRE_SERVICE_NAME'] = 'logfire-service'
    process.env['LOGFIRE_SERVICE_VERSION'] = '2.0.0'
    process.env['OTEL_SERVICE_NAME'] = 'otel-service'
    process.env['OTEL_SERVICE_VERSION'] = '1.2.3'

    configure()

    expect(logfireConfig.serviceName).toBe('logfire-service')
    expect(logfireConfig.serviceVersion).toBe('2.0.0')
  })

  it('lets code service metadata override LOGFIRE and OTEL environment variables', () => {
    process.env['LOGFIRE_SERVICE_NAME'] = 'logfire-service'
    process.env['LOGFIRE_SERVICE_VERSION'] = '2.0.0'
    process.env['OTEL_SERVICE_NAME'] = 'otel-service'
    process.env['OTEL_SERVICE_VERSION'] = '1.2.3'

    configure({
      serviceName: 'code-service',
      serviceVersion: '3.0.0',
    })

    expect(logfireConfig.serviceName).toBe('code-service')
    expect(logfireConfig.serviceVersion).toBe('3.0.0')
  })

  it('preserves boolean console configuration compatibility', () => {
    configure({ console: true })
    expect(logfireConfig.console).toBe(true)

    configure({ console: false })
    expect(logfireConfig.console).toBe(false)
  })

  it('stores object-style console configuration', () => {
    const consoleConfig = {
      includeTags: false,
      includeTimestamps: false,
      minLevel: 'warning' as const,
    }

    configure({ console: consoleConfig })

    expect(logfireConfig.console).toBe(consoleConfig)
  })

  it('rejects invalid object-style console min levels during configure', () => {
    expect(() => {
      configure({
        console: {
          minLevel: 'warn' as never,
        },
      })
    }).toThrow('Invalid console.minLevel')

    expect(logfireConfig.console).toBe(false)
  })

  it('reads LOGFIRE_CONSOLE as boolean true when code config omits console', () => {
    process.env['LOGFIRE_CONSOLE'] = 'true'

    configure()

    expect(logfireConfig.console).toBe(true)
  })

  it('does not parse LOGFIRE_CONSOLE as object-style console config', () => {
    process.env['LOGFIRE_CONSOLE'] = '{"enabled":true}'

    configure()

    expect(logfireConfig.console).toBe(false)
  })

  it('passes baggage span attributes config to the shared API', () => {
    configure({
      baggage: {
        spanAttributes: ['tenant'],
      },
    })

    expect(logfireConfig.baggage).toEqual({ spanAttributes: ['tenant'] })
    expect(logfireApiConfig.baggage).toEqual({ spanAttributes: ['tenant'] })
  })

  it('passes code minLevel config to the shared API', () => {
    configure({
      minLevel: 'warning',
    })

    expect(logfireApiConfig.minLevel).toBe(Level.Warning)
    expect(logfireConfig.minLevel).toBe(Level.Warning)
  })

  it('reads LOGFIRE_MIN_LEVEL when code config omits minLevel', () => {
    process.env['LOGFIRE_MIN_LEVEL'] = 'ERROR'

    configure()

    expect(logfireApiConfig.minLevel).toBe(Level.Error)
    expect(logfireConfig.minLevel).toBe(Level.Error)
  })

  it('lets code minLevel override LOGFIRE_MIN_LEVEL, including null reset', () => {
    process.env['LOGFIRE_MIN_LEVEL'] = 'error'

    configure({
      minLevel: null,
    })

    expect(logfireApiConfig.minLevel).toBeUndefined()
    expect(logfireConfig.minLevel).toBeUndefined()
  })

  it('warns and ignores invalid LOGFIRE_MIN_LEVEL values without dropping other shared API config', () => {
    process.env['LOGFIRE_MIN_LEVEL'] = 'verbose'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      configure({
        baggage: {
          spanAttributes: ['tenant'],
        },
      })

      expect(warnSpy).toHaveBeenCalledWith('Invalid LOGFIRE_MIN_LEVEL value "verbose" ignored.')
      expect(logfireApiConfig.minLevel).toBeUndefined()
      expect(logfireConfig.minLevel).toBeUndefined()
      expect(logfireApiConfig.baggage).toEqual({ spanAttributes: ['tenant'] })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('supports a token provider without resolving it during configure', async () => {
    const tokenProvider = vi.fn<() => Promise<string>>().mockResolvedValue('Bearer user-token')

    configure({
      advanced: { baseUrl: 'https://proxy.example.com/' },
      token: tokenProvider,
    })

    expect(logfireConfig.sendToLogfire).toBe(true)
    expect(logfireConfig.baseUrl).toBe('https://proxy.example.com')
    expect(logfireConfig.traceExporterUrl).toBe('https://proxy.example.com/v1/traces')
    expect(logfireConfig.logsExporterUrl).toBe('https://proxy.example.com/v1/logs')
    expect(logfireConfig.metricExporterUrl).toBe('https://proxy.example.com/v1/metrics')
    expect(tokenProvider).not.toHaveBeenCalled()

    expect(typeof logfireConfig.authorizationHeaders).toBe('function')
    if (typeof logfireConfig.authorizationHeaders !== 'function') {
      throw new Error('expected authorization headers provider')
    }
    await expect(logfireConfig.authorizationHeaders()).resolves.toEqual({ Authorization: 'Bearer user-token' })
    expect(tokenProvider).toHaveBeenCalledTimes(1)
  })

  it('uses LOGFIRE_BASE_URL for a token provider', () => {
    process.env['LOGFIRE_BASE_URL'] = 'https://proxy.example.com/'

    configure({
      token: () => 'Bearer user-token',
    })

    expect(logfireConfig.baseUrl).toBe('https://proxy.example.com')
  })

  it('throws when a token provider has no explicit base URL', () => {
    expect(() => {
      configure({
        token: () => 'Bearer user-token',
      })
    }).toThrow('advanced.baseUrl or LOGFIRE_BASE_URL is required when token is a function.')
  })

  it('does not require a base URL for a token provider when sending is disabled', () => {
    configure({
      sendToLogfire: false,
      token: () => 'Bearer user-token',
    })

    expect(logfireConfig.sendToLogfire).toBe(false)
    expect(logfireConfig.baseUrl).toBe('')
  })

  it('throws when explicit remote variables have no api key', () => {
    expect(() => {
      configure({
        variables: {
          polling: false,
          sse: false,
        },
      })
    }).toThrow('Remote variables require an API key')
  })
})
