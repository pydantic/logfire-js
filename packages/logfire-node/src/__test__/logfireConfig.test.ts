import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { shutdownVariables } from 'logfire/vars'

import { configure, logfireConfig } from '../logfireConfig'

vi.mock('../sdk', () => ({
  start: vi.fn<() => void>(),
}))

describe('logfire config', () => {
  const originalApiKey = process.env['LOGFIRE_API_KEY']

  beforeEach(async () => {
    process.env['LOGFIRE_API_KEY'] = ''
    await shutdownVariables()
  })

  afterEach(async () => {
    if (originalApiKey === undefined) {
      process.env['LOGFIRE_API_KEY'] = ''
    } else {
      process.env['LOGFIRE_API_KEY'] = originalApiKey
    }
    logfireConfig.resourceAttributes = {}
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
