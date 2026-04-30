import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getVariableProvider,
  LocalVariableProvider,
  LogfireRemoteVariableProvider,
  NoOpVariableProvider,
  shutdownVariables,
} from 'logfire/vars'

import { configure } from '../logfireConfig'

vi.mock('../sdk', () => ({
  start: vi.fn<() => void>(),
}))

describe('managed variables config', () => {
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

    expect(getVariableProvider()).toBeInstanceOf(LogfireRemoteVariableProvider)
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

    expect(getVariableProvider()).toBeInstanceOf(LogfireRemoteVariableProvider)
  })

  it('configures local and disabled providers explicitly', () => {
    configure({
      variables: {
        config: {
          variables: {},
        },
      },
    })
    expect(getVariableProvider()).toBeInstanceOf(LocalVariableProvider)

    configure({ variables: false })
    expect(getVariableProvider()).toBeInstanceOf(NoOpVariableProvider)
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
