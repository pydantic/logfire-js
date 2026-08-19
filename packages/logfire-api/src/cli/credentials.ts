import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { LOGFIRE_REGIONS, PYDANTIC_LOGFIRE_TOKEN_PATTERN } from '../tokenBaseUrl'
import type { Prompt } from './interactivePrompt'
import { LogfireCliError } from './errors'

export const DEFAULT_LOGFIRE_HOME = '.logfire'
export const USER_TOKEN_FILENAME = 'default.toml'
export const PROJECT_CREDENTIALS_FILENAME = 'logfire_credentials.json'
// Matches the Python CLI's filename exactly (not a new key on `logfire_credentials.json`):
// `readProjectCredentials` throws on an unrecognized field, so bolting one on would break
// exactly like Python's `LogfireCredentials(**data)` would have on an older reader. Same
// filename on both sides is also what lets a project set up by one SDK's CLI be read by
// the other.
export const READ_TOKEN_FILENAME = 'read_token.json'

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

export interface SavedReadToken {
  baseUrl: string
  token: string
}

export interface SaveReadTokenOptions {
  baseUrl: string
  expiresAt?: Date
  organization: string
  projectName: string
  token: string
}

export interface LoadSavedReadTokenOptions {
  organization: string
  projectName: string
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

/**
 * The organization a project URL belongs to, or `undefined` if it does not look like one.
 * `ProjectCredentials` stores the project URL but not the organization, and the
 * read-token endpoint needs both. Project URLs end in `<organization>/<project>`, so the
 * organization is the second-to-last path segment.
 */
export function organizationFromProjectUrl(projectUrl: string): string | undefined {
  let parts: string[]
  try {
    parts = new URL(projectUrl).pathname.split('/').filter((part) => part !== '')
  } catch {
    return undefined
  }
  return parts.length >= 2 ? parts[parts.length - 2] : undefined
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
  rmSync(readTokenPath(dataDir), { force: true })
  rmSync(join(dataDir, '.gitignore'), { force: true })
}

export function readTokenPath(dataDir: string): string {
  return join(dataDir, READ_TOKEN_FILENAME)
}

/**
 * Save a read token for reuse by `projects status`, instead of creating one on every
 * invocation. Read tokens are permanent and this CLI has no way to revoke one, so a
 * command meant to be re-run while waiting for data would otherwise leave a live
 * credential behind on every poll.
 *
 * `baseUrl` must be the host the CREATE request actually used (`client.baseUrl` after
 * `createAuthenticatedClient`), never re-derived from `logfire_credentials.json` at query
 * time: that file lives inside the project this command runs in, so a tampered repository
 * could point it at an attacker's server and this command would hand over the read token
 * in the next request's Authorization header. Deriving the host from the token's own
 * region prefix instead (as an earlier version of the Python CLI did) closes that hole but
 * silently breaks self-hosted deployments, whose base URL cannot be recovered from the
 * token -- only from where it was actually minted.
 */
export function saveReadToken(dataDir: string, options: SaveReadTokenOptions): string {
  ensureDataDir(dataDir)
  const path = readTokenPath(dataDir)
  const payload: Record<string, string> = {
    base_url: options.baseUrl,
    organization: options.organization,
    project_name: options.projectName,
    token: options.token,
  }
  if (options.expiresAt !== undefined) {
    payload['expires_at'] = options.expiresAt.toISOString()
  }
  writeFileSecurely(path, `${JSON.stringify(payload, null, 2)}\n`)
  return path
}

/**
 * A saved read token for THIS project, if there is one and it is still usable. Returns
 * `undefined` rather than throwing for every failure mode -- missing, unreadable, corrupt,
 * expired, or belonging to a different project -- so the caller can give one message
 * naming the command to run instead of several ways to fail.
 *
 * The project check matters: `projects use` repoints the directory, and a token left over
 * from the previous project would otherwise be sent for the new one and produce a
 * confusing 401 or, worse, another project's data.
 */
export function loadSavedReadToken(dataDir: string, options: LoadSavedReadTokenOptions): SavedReadToken | undefined {
  const path = readTokenPath(dataDir)
  if (!existsSync(path)) {
    return undefined
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(raw)) {
    return undefined
  }

  const token = readString(raw, 'token')
  const baseUrl = readString(raw, 'base_url')
  if (token === undefined || baseUrl === undefined) {
    return undefined
  }
  if (raw['organization'] !== options.organization || raw['project_name'] !== options.projectName) {
    return undefined
  }

  const expiresAt = raw['expires_at']
  // No `expires_at` means unbounded, not invalid: this CLI always writes one, so a file
  // without it was written by a different version or edited by hand. Refusing it would
  // break a working setup over a field we added -- the expiry exists to bound a leak, not
  // to gate the happy path.
  if (typeof expiresAt === 'string' && isExpired(expiresAt)) {
    return undefined
  }

  return { baseUrl, token }
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
    // `lstatSync`, not `statSync`: the data directory lives inside the user's repository,
    // so a symlink can arrive by being committed to it, the same way a symlinked
    // `read_token.json` can -- `writeFileSecurely`'s `O_NOFOLLOW` only protects that final
    // path component, not `dataDir` itself. `statSync` follows symlinks, so it would
    // report a symlinked `.logfire` pointing at a tracked or artifact-collected directory
    // as a perfectly ordinary directory, and every write meant for the ignored data
    // directory would silently land wherever the symlink actually points.
    const stat = lstatSync(dataDir)
    if (stat.isSymbolicLink()) {
      throw new LogfireCliError(`${dataDir} is a symlink; refusing to write Logfire data through it.`)
    }
    if (!stat.isDirectory()) {
      throw new LogfireCliError(`Data directory ${dataDir} exists but is not a directory`)
    }
    return
  }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, '.gitignore'), '*')
}

/**
 * Write a file readable only by its owner, refusing to follow a symlink at the
 * destination. The data directory lives inside the user's repository, so a symlink can
 * arrive by being committed to it; following one would apply `O_TRUNC` and a permissions
 * change to whatever it points at instead of the intended file.
 *
 * The mode passed to `openSync` only applies when it CREATES the file, so an existing
 * file keeps whatever permissions it had -- `fchmodSync` runs before any bytes are
 * written, not after, so the content is never briefly sitting in a world-readable file.
 */
function writeFileSecurely(path: string, contents: string): void {
  // `O_NOFOLLOW` is not available on every platform (notably Windows, where creating a
  // symlink needs a privilege most processes do not have); Node still exposes the
  // constant as `undefined` there rather than throwing, so this falls back to 0. The
  // `@types/node` type says `number`, not `number | undefined` -- that type is wrong on
  // those platforms, not this fallback.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above; the type is wrong on Windows.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)
  let fd: number
  try {
    fd = openSync(path, flags, 0o600)
  } catch (error) {
    throw new LogfireCliError(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, contents)
  } finally {
    closeSync(fd)
  }
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
