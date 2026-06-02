import { LogfireAPIClient } from 'logfire/datasets'
import type { LogfireAPIClientOptions } from 'logfire/datasets'

export * from 'logfire/datasets'

export interface CreateLogfireAPIClientOptions {
  apiKey?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createLogfireAPIClient(options: CreateLogfireAPIClientOptions = {}): LogfireAPIClient {
  const apiKey = options.apiKey ?? readNonEmptyEnv('LOGFIRE_API_KEY')
  const baseUrl = options.baseUrl ?? readNonEmptyEnv('LOGFIRE_BASE_URL')
  const clientOptions: LogfireAPIClientOptions = {
    apiKey: apiKey ?? '',
  }
  if (baseUrl !== undefined) {
    clientOptions.baseUrl = baseUrl
  }
  if (options.fetch !== undefined) {
    clientOptions.fetch = options.fetch
  }
  if (options.timeoutMs !== undefined) {
    clientOptions.timeoutMs = options.timeoutMs
  }
  return new LogfireAPIClient(clientOptions)
}

function readNonEmptyEnv(key: string): string | undefined {
  const value = process.env[key]
  return value === undefined || value.trim() === '' ? undefined : value
}
