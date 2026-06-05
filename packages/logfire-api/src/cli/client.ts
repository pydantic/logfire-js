import { hostname } from 'node:os'

import type { UserToken, UserTokenData } from './credentials'
import { LogfireCliError } from './errors'

export const USER_AGENT: string = `logfire-js/${PACKAGE_VERSION}`

export interface WritableProject {
  organization_name: string
  project_name: string
}

export interface Organization {
  organization_name: string
}

export interface ProjectTokenResponse {
  project_name: string
  project_url: string
  token: string
}

export interface UserInformation {
  name?: string
  default_organization?: {
    organization_name?: string
  }
}

export interface DeviceCodeResponse {
  device_code: string
  frontend_auth_url: string
}

export interface TokenInfoResponse {
  project_name: string
  project_url: string
}

export class ProjectAlreadyExistsError extends Error {
  constructor() {
    super('Project already exists')
    this.name = 'ProjectAlreadyExistsError'
  }
}

export class InvalidProjectNameError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidProjectNameError'
    this.reason = reason
  }
}

export interface LogfireApiClientOptions {
  fetch?: typeof fetch
  userAgent?: string
  userToken: UserToken
}

export class LogfireApiClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly headers: Record<string, string>

  constructor(options: LogfireApiClientOptions) {
    this.baseUrl = options.userToken.baseUrl
    this.fetchImpl = options.fetch ?? fetch
    this.headers = {
      Authorization: options.userToken.token,
      'User-Agent': options.userAgent ?? USER_AGENT,
    }
  }

  async getUserInformation(): Promise<UserInformation> {
    return await this.getJson<UserInformation>('/v1/account/me', 'Error retrieving user information')
  }

  async getUserOrganizations(): Promise<Organization[]> {
    return await this.getJson<Organization[]>('/v1/organizations/available-for-projects/', 'Error retrieving list of organizations')
  }

  async getUserProjects(): Promise<WritableProject[]> {
    return await this.getJson<WritableProject[]>('/v1/writable-projects/', 'Error retrieving list of projects')
  }

  async createNewProject(organization: string, projectName: string): Promise<ProjectTokenResponse> {
    const response = await this.request('/v1/organizations/' + encodeURIComponent(organization) + '/projects', {
      body: JSON.stringify({ project_name: projectName }),
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (response.status === 409) {
      throw new ProjectAlreadyExistsError()
    }
    if (response.status === 422) {
      throw new InvalidProjectNameError(await readInvalidProjectNameReason(response))
    }
    if (!response.ok) {
      throw new LogfireCliError('Error creating new project')
    }
    return (await response.json()) as ProjectTokenResponse
  }

  async createWriteToken(organization: string, projectName: string): Promise<ProjectTokenResponse> {
    return await this.postJson<ProjectTokenResponse>(
      `/v1/organizations/${encodeURIComponent(organization)}/projects/${encodeURIComponent(projectName)}/write-tokens/`,
      undefined,
      'Error creating project write token'
    )
  }

  async createReadToken(organization: string, projectName: string): Promise<{ token: string }> {
    return await this.postJson<{ token: string }>(
      `/v1/organizations/${encodeURIComponent(organization)}/projects/${encodeURIComponent(projectName)}/read-tokens`,
      { description: 'Created by Logfire CLI' },
      'Error creating project read token'
    )
  }

  private async getJson<T>(endpoint: string, errorMessage: string): Promise<T> {
    const response = await this.request(endpoint, { headers: this.headers, method: 'GET' })
    if (!response.ok) {
      throw new LogfireCliError(errorMessage)
    }
    return (await response.json()) as T
  }

  private async postJson<T>(endpoint: string, body: unknown, errorMessage: string): Promise<T> {
    const init: RequestInit = {
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      method: 'POST',
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    const response = await this.request(endpoint, init)
    if (!response.ok) {
      throw new LogfireCliError(errorMessage)
    }
    return (await response.json()) as T
  }

  private async request(endpoint: string, init: RequestInit): Promise<Response> {
    return await this.fetchImpl(urlFor(this.baseUrl, endpoint), init)
  }
}

export interface DeviceAuthOptions {
  baseUrl: string
  fetch?: typeof fetch
  machineName?: string
  userAgent?: string
}

export async function requestDeviceCode(options: DeviceAuthOptions): Promise<DeviceCodeResponse> {
  const fetchImpl = options.fetch ?? fetch
  const url = new URL(urlFor(options.baseUrl, '/v1/device-auth/new/'))
  url.searchParams.set('machine_name', options.machineName ?? hostname())
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': options.userAgent ?? USER_AGENT,
    },
    method: 'POST',
  })
  if (!response.ok) {
    throw new LogfireCliError('Failed to request a device code.')
  }
  return (await response.json()) as DeviceCodeResponse
}

export interface PollForTokenOptions {
  baseUrl: string
  deviceCode: string
  fetch?: typeof fetch
  maxAttempts?: number
  userAgent?: string
}

export async function pollForToken(options: PollForTokenOptions): Promise<UserTokenData> {
  const fetchImpl = options.fetch ?? fetch
  const maxAttempts = options.maxAttempts ?? 120
  let errors = 0

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each device-auth response before the next attempt.
    const response = await fetchImpl(urlFor(options.baseUrl, `/v1/device-auth/wait/${encodeURIComponent(options.deviceCode)}`), {
      headers: {
        'User-Agent': options.userAgent ?? USER_AGENT,
      },
      method: 'GET',
    }).catch(() => undefined)

    if (response === undefined || !response.ok) {
      errors += 1
      if (errors >= 4) {
        throw new LogfireCliError('Failed to poll for token.')
      }
      continue
    }

    // eslint-disable-next-line no-await-in-loop -- the response body must be read before deciding to poll again.
    const token = (await response.json()) as UserTokenData | null
    if (token !== null) {
      return token
    }
  }

  throw new LogfireCliError('Failed to poll for token.')
}

export async function getTokenInfo(
  writeToken: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<TokenInfoResponse | undefined> {
  const response = await fetchImpl(urlFor(baseUrl, '/v1/info'), {
    headers: {
      Authorization: writeToken,
      'User-Agent': USER_AGENT,
    },
    method: 'GET',
  }).catch(() => undefined)
  if (response === undefined || !response.ok) {
    return undefined
  }
  return (await response.json()) as TokenInfoResponse
}

export function urlFor(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

async function readInvalidProjectNameReason(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as unknown
    if (isRecord(data)) {
      const detail = data['detail']
      if (Array.isArray(detail)) {
        const first: unknown = detail[0]
        if (isRecord(first) && typeof first['msg'] === 'string') {
          return first['msg']
        }
      }
    }
  } catch {
    // Fall through to the generic message below.
  }
  return 'Invalid project name'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
