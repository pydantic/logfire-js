import { describe, expect, it } from 'vite-plus/test'

import { configureFrontend } from './index'

describe('configureFrontend', () => {
  it.each([
    [{ baseUrl: 'https://logfire-us.pydantic.dev', token: '' }, 'token must not be empty'],
    [{ baseUrl: 'ftp://logfire.example.com', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
    [{ baseUrl: 'https://logfire.example.com?region=us', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
    [{ baseUrl: 'https://logfire.example.com/tenant', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
    [{ baseUrl: 'not a URL', token: 'public' }, 'baseUrl must be an HTTP(S) origin'],
  ] as const)('rejects invalid frontend application configuration', (options, message) => {
    expect(() => configureFrontend(options)).toThrow(message)
  })
})
