import { describe, expect, it, vi } from 'vite-plus/test'

import {
  LogfireApiClient,
  InvalidProjectNameError,
  ProjectAlreadyExistsError,
  pollForToken,
  queryProject,
  requestDeviceCode,
  urlFor,
} from './client'
import { LogfireCliError } from './errors'

describe('CLI client', () => {
  it('uses Python-compatible device auth endpoints', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [
      jsonResponse({ device_code: 'DC', frontend_auth_url: 'https://example.com/auth' }),
      jsonResponse({ expiration: '2099-12-31T23:59:59Z', token: 'user-token' }),
    ])

    await expect(
      requestDeviceCode({ baseUrl: 'https://logfire-us.pydantic.dev', fetch: fetchImpl, machineName: 'machine' })
    ).resolves.toEqual({
      device_code: 'DC',
      frontend_auth_url: 'https://example.com/auth',
    })
    await expect(pollForToken({ baseUrl: 'https://logfire-us.pydantic.dev', deviceCode: 'DC', fetch: fetchImpl })).resolves.toEqual({
      expiration: '2099-12-31T23:59:59Z',
      token: 'user-token',
    })

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://logfire-us.pydantic.dev/v1/device-auth/new/?machine_name=machine'],
      ['GET', 'https://logfire-us.pydantic.dev/v1/device-auth/wait/DC'],
    ])
  })

  it('reports a non-JSON device-auth response instead of a parse error', async () => {
    const proxyPage = (): Response =>
      new Response('<html><body>Sign in to continue</body></html>', {
        headers: { 'content-type': 'text/html' },
        status: 200,
      })

    await expect(
      requestDeviceCode({ baseUrl: 'https://logfire-us.pydantic.dev', fetch: fetchSequence([], [proxyPage()]) })
    ).rejects.toThrow('Failed to request a device code: the response was not JSON.')

    // The poll retries an unparseable body the same way it retries a rejected request, and
    // gives up on the fourth, so a captive portal ends the login with the CLI's own message.
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [proxyPage(), proxyPage(), proxyPage(), proxyPage()])
    await expect(pollForToken({ baseUrl: 'https://logfire-us.pydantic.dev', deviceCode: 'DC', fetch: fetchImpl })).rejects.toThrow(
      'Failed to poll for token.'
    )
    expect(calls.length).toBe(4)
  })

  it('keeps polling while the device-auth response body is null', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [
      jsonResponse(null),
      jsonResponse(null),
      jsonResponse({ expiration: '2099-12-31T23:59:59Z', token: 'user-token' }),
    ])

    await expect(pollForToken({ baseUrl: 'https://logfire-us.pydantic.dev', deviceCode: 'DC', fetch: fetchImpl })).resolves.toEqual({
      expiration: '2099-12-31T23:59:59Z',
      token: 'user-token',
    })
    expect(calls.length).toBe(3)
  })

  it('uses project endpoints and auth headers', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireApiClient({
      fetch: fetchSequence(calls, [
        jsonResponse([{ organization_name: 'org', project_name: 'project' }]),
        jsonResponse([{ organization_name: 'org' }]),
        jsonResponse({ default_organization: { organization_name: 'org' }, name: 'User' }),
        jsonResponse({ project_name: 'project', project_url: 'url', token: 'write-token' }),
        jsonResponse({ token: 'read-token' }),
      ]),
      userToken: {
        baseUrl: 'https://logfire-us.pydantic.dev',
        expiration: '2099-12-31T23:59:59Z',
        token: 'user-token',
      },
    })

    await client.getUserProjects()
    await client.getUserOrganizations()
    await client.getUserInformation()
    await client.createWriteToken('org', 'project')
    await client.createReadToken('org', 'project')

    expect(calls.map((call) => [call.method, call.url, call.authorization])).toEqual([
      ['GET', 'https://logfire-us.pydantic.dev/v1/writable-projects/', 'user-token'],
      ['GET', 'https://logfire-us.pydantic.dev/v1/organizations/available-for-projects/', 'user-token'],
      ['GET', 'https://logfire-us.pydantic.dev/v1/account/me', 'user-token'],
      ['POST', 'https://logfire-us.pydantic.dev/v1/organizations/org/projects/project/write-tokens/', 'user-token'],
      ['POST', 'https://logfire-us.pydantic.dev/v1/organizations/org/projects/project/read-tokens', 'user-token'],
    ])
    expect(calls[4]?.body).toBe('{"description":"Created by Logfire CLI"}')
  })

  it('creates a new project with the Python-compatible endpoint and body', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireApiClient({
      fetch: fetchSequence(calls, [jsonResponse({ project_name: 'project', project_url: 'url', token: 'write-token' })]),
      userToken: {
        baseUrl: 'https://logfire-us.pydantic.dev',
        expiration: '2099-12-31T23:59:59Z',
        token: 'user-token',
      },
    })

    await expect(client.createNewProject('org', 'project')).resolves.toEqual({
      project_name: 'project',
      project_url: 'url',
      token: 'write-token',
    })

    expect(calls).toEqual([
      {
        authorization: 'user-token',
        body: '{"project_name":"project"}',
        method: 'POST',
        url: 'https://logfire-us.pydantic.dev/v1/organizations/org/projects',
      },
    ])
  })

  it('maps project creation errors', async () => {
    const duplicateClient = makeClient(jsonResponse({ detail: 'exists' }, 409))
    await expect(duplicateClient.createNewProject('org', 'project')).rejects.toBeInstanceOf(ProjectAlreadyExistsError)

    const invalidClient = makeClient(jsonResponse({ detail: [{ loc: ['body', 'project_name'], msg: 'bad name' }] }, 422))
    await expect(invalidClient.createNewProject('org', 'project')).rejects.toEqual(new InvalidProjectNameError('bad name'))
  })

  it('joins endpoint URLs against base URLs with or without trailing slashes', () => {
    expect(urlFor('https://example.com', '/v1/info')).toBe('https://example.com/v1/info')
    expect(urlFor('https://example.com/', '/v1/info')).toBe('https://example.com/v1/info')
  })

  it('includes an expiry on createReadToken only when one is passed', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireApiClient({
      fetch: fetchSequence(calls, [jsonResponse({ token: 'read-token' }), jsonResponse({ token: 'read-token' })]),
      userToken: { baseUrl: 'https://logfire-us.pydantic.dev', expiration: '2099-12-31T23:59:59Z', token: 'user-token' },
    })

    await client.createReadToken('org', 'project')
    await client.createReadToken('org', 'project', new Date('2099-01-01T00:00:00.000Z'))

    expect(calls.map((call) => call.body)).toEqual([
      '{"description":"Created by Logfire CLI"}',
      '{"description":"Created by Logfire CLI","expires_at":"2099-01-01T00:00:00.000Z"}',
    ])
  })

  it('queries a project with the read token, not the class auth headers', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [
      jsonResponse({ data: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 87, service_name: 'orders-web' }] }),
    ])

    await expect(
      queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', {
        fetch: fetchImpl,
        limit: 10_000,
        minTimestamp: new Date('2026-08-19T00:00:00.000Z'),
      })
    ).resolves.toEqual([{ last_seen: '2026-08-19T01:00:00.000Z', records: 87, service_name: 'orders-web' }])

    expect(calls).toEqual([
      {
        authorization: 'read-token',
        body: '{"sql":"SELECT 1","min_timestamp":"2026-08-19T00:00:00.000Z","limit":10000}',
        method: 'POST',
        url: 'https://logfire-us.pydantic.dev/v2/query',
      },
    ])
  })

  it('rejects a query with a status other than exactly 200', async () => {
    // Not `response.ok`: a 204 is "not an error" by that test and would then fail parsing
    // the body as JSON instead of surfacing this message. 204 is a "null body status", so
    // the Response constructor requires `null`, not an empty string, as the body.
    const fetchImpl = fetchSequence([], [new Response(null, { status: 204 })])
    await expect(queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', { fetch: fetchImpl })).rejects.toEqual(
      new LogfireCliError('Could not read the project: 204 ')
    )
  })

  it('strips control characters from a non-200 response body before it reaches the error message', async () => {
    // The body of a non-200 response is whatever the server (or a proxy/WAF answering on
    // its behalf) sent, not something this CLI generated -- the same untrusted-text
    // reasoning `printableCell` applies to a telemetry-supplied service name.
    const fetchImpl = fetchSequence([], [new Response('evil\x1b[2Kmessage', { status: 500 })])
    await expect(queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', { fetch: fetchImpl })).rejects.toEqual(
      new LogfireCliError('Could not read the project: 500 evil�[2Kmessage')
    )
  })

  it.each([
    ['not json at all', 'not json at all'],
    ['{"no_data_key":[]}', '{"no_data_key":[]}'],
    ['{"data":"not a list"}', '{"data":"not a list"}'],
    ['{"data":["not","objects"]}', '{"data":["not","objects"]}'],
  ])('rejects a malformed 200 response body: %s', async (_label, body) => {
    // A 200 does not guarantee the real backend produced the body -- a proxy or WAF can
    // intercept the request and answer with its own page.
    const fetchImpl = fetchSequence([], [new Response(body, { status: 200 })])
    await expect(queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', { fetch: fetchImpl })).rejects.toBeInstanceOf(
      LogfireCliError
    )
  })

  it('reports a network failure cleanly instead of an unhandled rejection', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await Promise.resolve()
      throw new Error('connect ECONNREFUSED')
    })
    await expect(queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', { fetch: fetchImpl })).rejects.toEqual(
      new LogfireCliError('Could not reach https://logfire-us.pydantic.dev: connect ECONNREFUSED')
    )
  })

  it('strips control characters from query connection errors', async () => {
    const rejectedFetch = vi.fn<typeof fetch>(async () => Promise.reject(new Error('connect\x1b[2Kfailed')))
    await expect(queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', { fetch: rejectedFetch })).rejects.toEqual(
      new LogfireCliError('Could not reach https://logfire-us.pydantic.dev: connect�[2Kfailed')
    )

    const unusedFetch = vi.fn<typeof fetch>()
    await expect(queryProject('bad\x1b[2Kurl', 'read-token', 'SELECT 1', { fetch: unusedFetch })).rejects.toEqual(
      new LogfireCliError('Could not reach bad�[2Kurl: Invalid URL')
    )
    expect(unusedFetch).not.toHaveBeenCalled()
  })

  it('wraps a failure while reading a non-200 response body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve({
        status: 500,
        text: async () => Promise.reject(new Error('terminated\x1b[2K')),
      } as unknown as Response)
    )

    await expect(queryProject('https://logfire-us.pydantic.dev', 'read-token', 'SELECT 1', { fetch: fetchImpl })).rejects.toEqual(
      new LogfireCliError('Could not read the project response: terminated�[2K')
    )
  })
})

interface CapturedRequest {
  authorization: string | undefined
  body: string | undefined
  method: string
  url: string
}

function makeClient(response: Response): LogfireApiClient {
  return new LogfireApiClient({
    fetch: fetchSequence([], [response]),
    userToken: {
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiration: '2099-12-31T23:59:59Z',
      token: 'user-token',
    },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

function fetchSequence(calls: CapturedRequest[], responses: Response[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    await Promise.resolve()
    const headers = new Headers(init?.headers)
    calls.push({
      authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
      method: init?.method ?? 'GET',
      url: requestUrl(input),
    })
    const response = responses.shift()
    if (response === undefined) {
      throw new Error(`Unexpected fetch call to ${requestUrl(input)}`)
    }
    return response
  })
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
    status,
  })
}
