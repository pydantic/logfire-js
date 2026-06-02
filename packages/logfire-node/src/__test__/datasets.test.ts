import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { LogfireAPIClient, createLogfireAPIClient } from '../datasets'

interface CapturedRequest {
  headers: Headers
  url: string
}

describe('node datasets API client helper', () => {
  const originalApiKey = process.env['LOGFIRE_API_KEY']
  const originalBaseUrl = process.env['LOGFIRE_BASE_URL']

  beforeEach(() => {
    delete process.env['LOGFIRE_API_KEY']
    delete process.env['LOGFIRE_BASE_URL']
  })

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env['LOGFIRE_API_KEY']
    } else {
      process.env['LOGFIRE_API_KEY'] = originalApiKey
    }
    if (originalBaseUrl === undefined) {
      delete process.env['LOGFIRE_BASE_URL']
    } else {
      process.env['LOGFIRE_BASE_URL'] = originalBaseUrl
    }
  })

  it('reads LOGFIRE_API_KEY and LOGFIRE_BASE_URL', async () => {
    process.env['LOGFIRE_API_KEY'] = 'lf-env-api-key'
    process.env['LOGFIRE_BASE_URL'] = 'https://env.example.com/'
    const calls: CapturedRequest[] = []
    const client = createLogfireAPIClient({ fetch: fetchSequence(calls) })

    expect(client).toBeInstanceOf(LogfireAPIClient)
    expect((client as unknown as Record<string, unknown>)['pushEvaluationDataset']).toEqual(expect.any(Function))
    expect((client as unknown as Record<string, unknown>)['getEvaluationDataset']).toEqual(expect.any(Function))
    await client.listDatasets()

    expect(calls[0]?.url).toBe('https://env.example.com/v1/datasets/')
    expect(calls[0]?.headers.get('Authorization')).toBe('bearer lf-env-api-key')
  })

  it('lets explicit options override environment variables', async () => {
    process.env['LOGFIRE_API_KEY'] = 'lf-env-api-key'
    process.env['LOGFIRE_BASE_URL'] = 'https://env.example.com'
    const calls: CapturedRequest[] = []
    const client = createLogfireAPIClient({
      apiKey: 'lf-explicit-api-key',
      baseUrl: 'https://explicit.example.com',
      fetch: fetchSequence(calls),
    })

    await client.listDatasets()

    expect(calls[0]?.url).toBe('https://explicit.example.com/v1/datasets/')
    expect(calls[0]?.headers.get('Authorization')).toBe('bearer lf-explicit-api-key')
  })

  it('throws a clear error when no API key is available', () => {
    expect(() => createLogfireAPIClient()).toThrow('requires an API key')
  })
})

function fetchSequence(calls: CapturedRequest[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    await Promise.resolve()
    calls.push({
      headers: new Headers(init?.headers),
      url: requestInputToUrl(input),
    })
    return new Response('[]', { status: 200 })
  })
}

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}
