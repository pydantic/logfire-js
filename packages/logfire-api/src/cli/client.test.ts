import { describe, expect, it, vi } from 'vite-plus/test'

import { LogfireApiClient, InvalidProjectNameError, ProjectAlreadyExistsError, pollForToken, requestDeviceCode, urlFor } from './client'

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
