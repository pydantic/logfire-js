import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { LOGFIRE_REGIONS, PYDANTIC_LOGFIRE_TOKEN_PATTERN } from '../tokenBaseUrl'
import type { Prompt } from './interactivePrompt'
import { LogfireCliError } from './errors'

export const DEFAULT_LOGFIRE_HOME = '.logfire'
export const USER_TOKEN_FILENAME = 'default.toml'
export const PROJECT_CREDENTIALS_FILENAME = 'logfire_credentials.json'

export interface UserTokenData {
  token: string
  expiration: string
}

export interface UserToken extends UserTokenData {
  baseUrl: string
}

export interface ProjectCredentials {
  token: string
  project_name: string
  project_url: string
  logfire_api_url: string
}

export function defaultAuthFilePath(homeDir: string = homedir()): string {
  return join(homeDir, DEFAULT_LOGFIRE_HOME, USER_TOKEN_FILENAME)
}

export function defaultDataDir(cwd: string = process.cwd()): string {
  return join(cwd, DEFAULT_LOGFIRE_HOME)
}

export function projectCredentialsPath(dataDir: string): string {
  return join(dataDir, PROJECT_CREDENTIALS_FILENAME)
}

export function isExpired(expiration: string): boolean {
  // Match Python, which parses naive timestamps as UTC but honors explicit offsets:
  // only assume UTC when the string carries no timezone designator of its own.
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(expiration)
  const normalizedExpiration = hasTimezone ? expiration : `${expiration}Z`
  const expiresAt = new Date(normalizedExpiration).getTime()
  return Number.isNaN(expiresAt) || Date.now() >= expiresAt
}

export function formatUserToken(userToken: UserToken): string {
  let region = 'us'
  const match = PYDANTIC_LOGFIRE_TOKEN_PATTERN.exec(userToken.token)
  if (match) {
    const matchedRegion = match.groups?.['region']
    if (matchedRegion !== undefined && Object.hasOwn(LOGFIRE_REGIONS, matchedRegion)) {
      region = matchedRegion
    }
  }

  const safePrefix = match?.groups?.['safePart'] ?? ''
  const tokenPrefix = match?.groups?.['token']?.slice(0, 5) ?? userToken.token.slice(0, 5)
  return `${region.toUpperCase()} (${userToken.baseUrl}) - ${safePrefix}${tokenPrefix}****`
}

export class UserTokenCollection {
  readonly path: string
  readonly userTokens: Map<string, UserToken>

  constructor(path: string = defaultAuthFilePath()) {
    this.path = path
    this.userTokens = readUserTokensFile(path)
  }

  isLoggedIn(baseUrl?: string): boolean {
    const tokens =
      baseUrl === undefined ? [...this.userTokens.values()] : [...this.userTokens.values()].filter((token) => token.baseUrl === baseUrl)
    return tokens.some((token) => !isExpired(token.expiration))
  }

  async getToken(baseUrl: string | undefined, prompt?: Prompt): Promise<UserToken> {
    let token: UserToken | undefined
    const tokens = [...this.userTokens.values()]

    if (baseUrl !== undefined) {
      token = this.userTokens.get(baseUrl)
      if (token === undefined) {
        throw new LogfireCliError(
          `No user token was found matching the ${baseUrl} Logfire URL. Please run \`logfire auth\` to authenticate.`
        )
      }
    } else if (tokens.length === 1) {
      token = tokens[0]
    } else if (tokens.length >= 2) {
      if (prompt === undefined) {
        throw new LogfireCliError('Multiple user tokens found. Pass --region or --base-url to select one.')
      }
      const choices = tokens.map((_, index) => String(index + 1))
      const choicesText = tokens
        .map(
          (candidate, index) =>
            `${String(index + 1)}. ${formatUserToken(candidate)} (${isExpired(candidate.expiration) ? 'expired' : 'valid'})`
        )
        .join('\n')
      const selected = await prompt.choice(`Multiple user tokens found. Please select one:\n${choicesText}\n`, choices)
      token = tokens[Number(selected) - 1]
    } else {
      throw new LogfireCliError('You are not logged into Logfire. Please run `logfire auth` to authenticate.')
    }

    if (token === undefined) {
      throw new LogfireCliError('You are not logged into Logfire. Please run `logfire auth` to authenticate.')
    }
    if (isExpired(token.expiration)) {
      throw new LogfireCliError(`User token ${formatUserToken(token)} is expired. Please run \`logfire auth\` to authenticate.`)
    }
    return token
  }

  addToken(baseUrl: string, tokenData: UserTokenData): UserToken {
    const userToken: UserToken = { ...tokenData, baseUrl }
    this.userTokens.set(baseUrl, userToken)
    writeUserTokensFile(this.path, this.userTokens)
    return userToken
  }

  logout(baseUrl?: string): string[] {
    if (this.userTokens.size === 0) {
      throw new LogfireCliError('You are not logged into Logfire. Please run `logfire auth` to authenticate.')
    }
    if (baseUrl !== undefined && !this.userTokens.has(baseUrl)) {
      throw new LogfireCliError(`No user token was found matching the ${baseUrl} Logfire URL. Please run \`logfire auth\` to authenticate.`)
    }
    const removed = baseUrl === undefined ? [...this.userTokens.keys()] : [baseUrl]
    for (const url of removed) {
      this.userTokens.delete(url)
    }
    writeUserTokensFile(this.path, this.userTokens)
    return removed
  }
}

export function parseUserTokensToml(text: string): Map<string, UserToken> {
  const tokens = new Map<string, UserToken>()
  let currentBaseUrl: string | undefined

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }

    const section = line.match(/^\[tokens\."((?:[^"\\]|\\.)*)"\]$/u)
    if (section) {
      currentBaseUrl = unquoteTomlString(section[1] ?? '')
      tokens.set(currentBaseUrl, { baseUrl: currentBaseUrl, expiration: '', token: '' })
      continue
    }

    if (line.startsWith('[')) {
      currentBaseUrl = undefined
      continue
    }

    if (currentBaseUrl === undefined) {
      continue
    }
    const assignment = line.match(/^(token|expiration)\s*=\s*"((?:[^"\\]|\\.)*)"$/u)
    if (assignment) {
      const token = tokens.get(currentBaseUrl)
      if (token !== undefined) {
        token[assignment[1] as 'token' | 'expiration'] = unquoteTomlString(assignment[2] ?? '')
      }
    }
  }

  for (const [baseUrl, token] of tokens) {
    if (token.token === '' || token.expiration === '') {
      tokens.delete(baseUrl)
    }
  }
  return tokens
}

export function stringifyUserTokensToml(tokens: ReadonlyMap<string, UserToken>): string {
  let output = ''
  for (const [baseUrl, token] of tokens) {
    output += `[tokens."${quoteTomlString(baseUrl)}"]\n`
    output += `token = "${quoteTomlString(token.token)}"\n`
    output += `expiration = "${quoteTomlString(token.expiration)}"\n`
  }
  return output
}

export function readProjectCredentials(dataDir: string): ProjectCredentials | undefined {
  const path = projectCredentialsPath(dataDir)
  if (!existsSync(path)) {
    return undefined
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new LogfireCliError(`Invalid credentials file: ${path}`)
  }

  if (!isRecord(raw)) {
    throw new LogfireCliError(`Invalid credentials file: ${path}`)
  }
  const projectUrl = readString(raw, 'project_url') ?? readString(raw, 'dashboard_url')
  const token = readString(raw, 'token')
  const projectName = readString(raw, 'project_name')
  const logfireApiUrl = readString(raw, 'logfire_api_url')
  if (token === undefined || projectName === undefined || projectUrl === undefined || logfireApiUrl === undefined) {
    throw new LogfireCliError(`Invalid credentials file: ${path}`)
  }
  return {
    logfire_api_url: logfireApiUrl,
    project_name: projectName,
    project_url: projectUrl,
    token,
  }
}

export function writeProjectCredentials(dataDir: string, credentials: ProjectCredentials): void {
  ensureDataDir(dataDir)
  writeFileSync(projectCredentialsPath(dataDir), `${JSON.stringify(credentials, null, 2)}\n`)
}

export function removeProjectCredentials(dataDir: string): void {
  rmSync(projectCredentialsPath(dataDir), { force: true })
  rmSync(join(dataDir, '.gitignore'), { force: true })
}

function readUserTokensFile(path: string): Map<string, UserToken> {
  if (!existsSync(path)) {
    return new Map()
  }
  return parseUserTokensToml(readFileSync(path, 'utf8'))
}

function writeUserTokensFile(path: string, tokens: ReadonlyMap<string, UserToken>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringifyUserTokensToml(tokens))
}

function ensureDataDir(dataDir: string): void {
  // Match Python's `ensure_data_dir_exists`: only seed `.gitignore` when creating the
  // directory, so an existing dir's ignore rules are never clobbered.
  if (existsSync(dataDir)) {
    if (!statSync(dataDir).isDirectory()) {
      throw new LogfireCliError(`Data directory ${dataDir} exists but is not a directory`)
    }
    return
  }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, '.gitignore'), '*')
}

function quoteTomlString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

function unquoteTomlString(value: string): string {
  return value.replace(/\\(["\\])/gu, '$1')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
