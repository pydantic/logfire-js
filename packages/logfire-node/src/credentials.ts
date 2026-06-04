import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROJECT_CREDENTIALS_FILENAME = 'logfire_credentials.json'

export interface ProjectCredentials {
  token: string
  project_name: string
  project_url: string
  logfire_api_url: string
}

export function readLocalProjectCredentials(dataDir: string): ProjectCredentials | undefined {
  const path = join(dataDir, PROJECT_CREDENTIALS_FILENAME)
  if (!existsSync(path)) {
    return undefined
  }

  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error(`Invalid credentials file: ${path}`)
  }

  if (!isRecord(data)) {
    throw new Error(`Invalid credentials file: ${path}`)
  }

  const projectUrl = readString(data, 'project_url') ?? readString(data, 'dashboard_url')
  const token = readString(data, 'token')
  const projectName = readString(data, 'project_name')
  const logfireApiUrl = readString(data, 'logfire_api_url')
  if (token === undefined || projectName === undefined || projectUrl === undefined || logfireApiUrl === undefined) {
    throw new Error(`Invalid credentials file: ${path}`)
  }

  return {
    logfire_api_url: logfireApiUrl,
    project_name: projectName,
    project_url: projectUrl,
    token,
  }
}

export function resolveCredentialsDir(option: string | undefined, env: NodeJS.ProcessEnv, cwd: string = process.cwd()): string {
  return nonBlank(option) ?? nonBlank(env['LOGFIRE_CREDENTIALS_DIR']) ?? join(cwd, '.logfire')
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
