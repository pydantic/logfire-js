import { PlatformConfigurationError, PlatformHTTPError, PlatformJSONError, PlatformTimeoutError, PlatformTransportError } from './errors'

export interface PlatformAPIClientOptions {
  apiKey: string
  baseUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface PlatformRequestOptions {
  body?: unknown
  method?: string
  query?: Record<string, boolean | number | string | undefined>
}

export class PlatformAPIClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: PlatformAPIClientOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = trimTrailingSlash(options.baseUrl)
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (typeof this.fetchImpl !== 'function') {
      throw new PlatformConfigurationError('Logfire platform API requests require a fetch implementation')
    }
  }

  async requestJson(path: string, options: PlatformRequestOptions = {}): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)

    try {
      const init: RequestInit = {
        headers: this.buildHeaders(),
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        signal: controller.signal,
      }
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body)
      }
      const response = await this.fetchImpl(this.buildUrl(path, options.query), {
        ...init,
      })
      if (!response.ok) {
        throw new PlatformHTTPError(response.status, response.statusText, await parseErrorDetail(response))
      }
      if (response.status === 204) {
        return undefined
      }
      return await parseSuccessJson(response)
    } catch (error) {
      if (error instanceof PlatformConfigurationError || error instanceof PlatformHTTPError || error instanceof PlatformJSONError) {
        throw error
      }
      if (isAbortError(error)) {
        throw new PlatformTimeoutError('Logfire platform API request timed out')
      }
      if (error instanceof PlatformTransportError) {
        throw error
      }
      throw new PlatformTransportError(`Logfire platform API request failed: ${formatError(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private buildHeaders(): Headers {
    const headers = new Headers()
    headers.set('Accept', 'application/json')
    headers.set('Authorization', `bearer ${this.apiKey}`)
    headers.set('Content-Type', 'application/json')
    return headers
  }

  private buildUrl(path: string, query: PlatformRequestOptions['query']): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.baseUrl}${normalizedPath}`)
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value))
        }
      }
    }
    return url.toString()
  }
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

async function parseErrorDetail(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim() === '') {
    return response.statusText === '' ? `HTTP ${response.status.toString()}` : response.statusText
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function parseSuccessJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new PlatformJSONError(`Logfire platform API response was not valid JSON: ${formatError(error)}`)
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name?: unknown }).name === 'AbortError'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
