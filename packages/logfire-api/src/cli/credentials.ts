import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
const READ_TOKEN_IGNORE_PATTERN = `${READ_TOKEN_FILENAME}*`

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

export interface ReadTokenSaveReservation {
  abort(): void
  save(options: SaveReadTokenOptions): string
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
 * Whether `path` is tracked by the git repository it sits in, if any.
 *
 * `.gitignore` only stops an UNTRACKED file from being added; it does nothing for a path
 * already in the index -- committed before this feature existed, or by mistake -- so
 * writing a real, permanent credential through such a path would make the next `git
 * commit -am` publish it. Operational failures must fail closed: only Git's documented
 * no-match exit means the path is untracked.
 */
function isGitTracked(path: string): boolean {
  if (!hasGitMetadata(dirname(path))) {
    return false
  }
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', basename(path)], {
      cwd: dirname(path),
      stdio: 'ignore',
      timeout: 5000,
    })
    return true
  } catch (error) {
    if (hasExitStatus(error, 1)) {
      return false
    }
    throw error
  }
}

function hasGitMetadata(path: string): boolean {
  let current = path
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      return true
    }
    const parent = dirname(current)
    if (parent === current) {
      return false
    }
    current = parent
  }
}

function hasExitStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status
}

/**
 * Validate and reserve the saved-token destination before minting a token. The staged
 * file stays empty until `save`, so aborting a failed mint preserves any existing token.
 */
export function reserveReadTokenSave(dataDir: string): ReadTokenSaveReservation {
  ensureDataDir(dataDir)
  const path = readTokenPath(dataDir)
  const lockPath = join(dataDir, `${READ_TOKEN_FILENAME}.lock`)
  try {
    if (isGitTracked(path)) {
      throw new LogfireCliError(
        `${path} is already tracked by git, so .gitignore does not protect it. Writing the token there risks it reaching a commit. Untrack it first (\`git rm --cached ${path}\`) or remove it, then try again.`
      )
    }
  } catch (error) {
    throw error instanceof LogfireCliError
      ? error
      : new LogfireCliError(`${path} could not be checked against the git index; refusing to save a read token there.`)
  }

  try {
    ensureReadTokenIgnored(dataDir)
    if (existsSync(path)) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        throw new LogfireCliError(`${path} is a symlink; refusing to write a Logfire read token through it.`)
      }
      if (!stat.isFile()) {
        throw new LogfireCliError(`${path} exists but is not a regular file.`)
      }
    }
  } catch (error) {
    throw error instanceof LogfireCliError ? error : writeReadTokenError(path, error)
  }

  const temporaryPath = join(dataDir, `${READ_TOKEN_FILENAME}.${randomUUID()}.tmp`)
  let fd: number | undefined
  let lockFd: number | undefined
  let ownsLock = false
  const cleanupReservationFiles = (): Error | undefined => {
    let cleanupError: Error | undefined
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error))
      }
      fd = undefined
    }
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd)
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error))
      }
      lockFd = undefined
    }
    try {
      rmSync(temporaryPath, { force: true })
    } catch (error) {
      cleanupError ??= error instanceof Error ? error : new Error(String(error))
    }
    if (ownsLock) {
      try {
        rmSync(lockPath, { force: true })
        ownsLock = false
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error))
      }
    }
    return cleanupError
  }

  try {
    lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    ownsLock = true
    fchmodSync(lockFd, 0o600)
    fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    fchmodSync(fd, 0o600)
  } catch (error) {
    const cleanupError = cleanupReservationFiles()
    if (hasErrorCode(error, 'EEXIST')) {
      throw new LogfireCliError(
        `Another read-token save is already in progress for ${path}. If no other command is running, remove ${lockPath} and try again.`
      )
    }
    throw writeReadTokenError(path, cleanupError ?? error)
  }

  let active = true
  const abort = (): void => {
    if (!active) {
      return
    }
    active = false
    const error = cleanupReservationFiles()
    if (error !== undefined) {
      throw writeReadTokenError(path, error)
    }
  }

  return {
    abort,
    save(options) {
      if (!active || fd === undefined) {
        throw new LogfireCliError(`Could not write ${path}: the save reservation is no longer active.`)
      }
      try {
        writeFileSync(fd, serializeReadToken(options))
        closeSync(fd)
        fd = undefined
        renameSync(temporaryPath, path)
        const cleanupError = cleanupReservationFiles()
        if (cleanupError !== undefined) {
          throw cleanupError
        }
        active = false
        return path
      } catch (error) {
        let finalError = error
        try {
          abort()
        } catch (cleanupError) {
          finalError = cleanupError
        }
        throw finalError instanceof LogfireCliError ? finalError : writeReadTokenError(path, finalError)
      }
    },
  }
}

/**
 * Save a read token for reuse by `projects status`, instead of creating one on every
 * invocation. `baseUrl` must be the host the create request actually used, because a
 * self-hosted deployment cannot be reconstructed from the token.
 */
export function saveReadToken(dataDir: string, options: SaveReadTokenOptions): string {
  const reservation = reserveReadTokenSave(dataDir)
  try {
    return reservation.save(options)
  } finally {
    reservation.abort()
  }
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
  let raw: unknown
  try {
    if (!lstatSync(path).isFile() || isGitTracked(path)) {
      return undefined
    }
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
  // Absent (`undefined`) means unbounded, not invalid: this CLI always writes the key, so
  // a file without it was written by a different version or edited by hand. Refusing it
  // would break a working setup over a field we added -- the expiry exists to bound a
  // leak, not to gate the happy path. PRESENT but not a string is different: this file
  // always writes a string, so `null`/a number/etc. did not come from a normal run, and
  // treating it the same as absent -- which a bare `typeof expiresAt === 'string'` check
  // does, since it is also false for a present `null` -- would let a tampered file defeat
  // the TTL entirely instead of merely losing it. `JSON.parse` keeps a `null` present key
  // distinct from a missing one (`undefined`), so this can tell them apart.
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string') {
      return undefined
    }
    if (isExpired(expiresAt)) {
      return undefined
    }
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

export function ensureDataDir(dataDir: string): void {
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
  } else {
    mkdirSync(dataDir, { recursive: true })
  }
  seedGitignore(dataDir)
}

/**
 * Write the `*` ignore rule for a directory that holds nothing but the files Logfire writes
 * itself. That covers a newly created directory and one `logfire clean` has emptied, which
 * removes the `.gitignore` along with the credentials. A directory with any other contents is
 * left alone: `--data-dir` can point at a directory of the user's own, and `*` would ignore it.
 */
function seedGitignore(dataDir: string): void {
  if (!readdirSync(dataDir).every(isDataDirFile)) {
    return
  }
  try {
    // Exclusive creation, so an existing `.gitignore` keeps its rules and a symlink planted in a
    // data directory that arrived from elsewhere is refused rather than written through.
    writeFileSync(join(dataDir, '.gitignore'), '*', { flag: 'wx' })
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error
    }
  }
}

function isDataDirFile(name: string): boolean {
  return name === '.gitignore' || name === PROJECT_CREDENTIALS_FILENAME || name.startsWith(READ_TOKEN_FILENAME)
}

function ensureReadTokenIgnored(dataDir: string): void {
  const path = join(dataDir, '.gitignore')
  let contents = ''
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) {
      throw new LogfireCliError(`${path} is a symlink; refusing to update ignore rules through it.`)
    }
    contents = readFileSync(path, 'utf8')
  }

  const rules = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const lastRule = rules.at(-1)
  if (lastRule === '*' || lastRule === READ_TOKEN_IGNORE_PATTERN || lastRule === `/${READ_TOKEN_IGNORE_PATTERN}`) {
    return
  }
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${contents}${separator}${READ_TOKEN_IGNORE_PATTERN}\n`)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function serializeReadToken(options: SaveReadTokenOptions): string {
  const payload: Record<string, string> = {
    base_url: options.baseUrl,
    organization: options.organization,
    project_name: options.projectName,
    token: options.token,
  }
  if (options.expiresAt !== undefined) {
    payload['expires_at'] = options.expiresAt.toISOString()
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

function writeReadTokenError(path: string, error: unknown): LogfireCliError {
  return new LogfireCliError(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`)
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
