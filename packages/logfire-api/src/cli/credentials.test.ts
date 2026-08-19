import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vite-plus/test'

import {
  UserTokenCollection,
  formatUserToken,
  isExpired,
  loadSavedReadToken,
  organizationFromProjectUrl,
  parseUserTokensToml,
  projectCredentialsPath,
  readProjectCredentials,
  readTokenPath,
  removeProjectCredentials,
  saveReadToken,
  stringifyUserTokensToml,
  writeProjectCredentials,
} from './credentials'
import { LogfireCliError } from './errors'

describe('CLI credentials', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('parses and writes Python-compatible user token TOML', () => {
    const tokens = parseUserTokensToml(`
# global credentials
[tokens."https://logfire-us.pydantic.dev"]
token = "abc\\\\def\\"quoted"
expiration = "2099-12-31T23:59:59Z"

[other]
token = "ignored"
`)

    expect(tokens.get('https://logfire-us.pydantic.dev')).toEqual({
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiration: '2099-12-31T23:59:59Z',
      token: 'abc\\def"quoted',
    })
    expect(parseUserTokensToml(stringifyUserTokensToml(tokens))).toEqual(tokens)
  })

  it('treats naive expirations as UTC and honors explicit offsets', () => {
    expect(isExpired('2099-12-31T23:59:59')).toBe(false)
    expect(isExpired('2099-12-31T23:59:59Z')).toBe(false)
    expect(isExpired('2099-12-31T23:59:59+00:00')).toBe(false)
    expect(isExpired('2000-01-01T00:00:00Z')).toBe(true)
    expect(isExpired('2000-01-01T00:00:00+00:00')).toBe(true)
    expect(isExpired('not-a-date')).toBe(true)
  })

  it('selects, formats, and logs out user tokens', async () => {
    const dir = makeTmpDir()
    const path = join(dir, 'default.toml')
    const collection = new UserTokenCollection(path)

    const token = collection.addToken('https://logfire-us.pydantic.dev', {
      expiration: '2099-12-31T23:59:59Z',
      token: 'pylf_v1_us_1234567890',
    })

    expect(await collection.getToken('https://logfire-us.pydantic.dev')).toEqual(token)
    expect(formatUserToken(token)).toBe('US (https://logfire-us.pydantic.dev) - pylf_v1_us_12345****')
    expect(collection.logout('https://logfire-us.pydantic.dev')).toEqual(['https://logfire-us.pydantic.dev'])
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('writes and reads local project credentials, seeding .gitignore on creation', () => {
    const dir = join(makeTmpDir(), 'nested', '.logfire')
    const credentials = {
      logfire_api_url: 'https://logfire-us.pydantic.dev',
      project_name: 'myproject',
      project_url: 'https://logfire.pydantic.dev/org/myproject',
      token: 'write-token',
    }

    writeProjectCredentials(dir, credentials)

    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*')
    expect(JSON.parse(readFileSync(projectCredentialsPath(dir), 'utf8'))).toEqual(credentials)
    expect(readProjectCredentials(dir)).toEqual(credentials)
  })

  it('does not clobber an existing .gitignore in the data dir', () => {
    const dir = makeTmpDir()
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')

    writeProjectCredentials(dir, {
      logfire_api_url: 'https://logfire-us.pydantic.dev',
      project_name: 'myproject',
      project_url: 'https://logfire.pydantic.dev/org/myproject',
      token: 'write-token',
    })

    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n')
  })

  it('saves and loads a read token, scoped to the org and project that issued it', () => {
    const dir = makeTmpDir()
    const expiresAt = new Date('2099-12-31T23:59:59.000Z')

    const path = saveReadToken(dir, {
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiresAt,
      organization: 'test-org',
      projectName: 'orders',
      token: 'read-token',
    })

    expect(path).toBe(readTokenPath(dir))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      base_url: 'https://logfire-us.pydantic.dev',
      expires_at: '2099-12-31T23:59:59.000Z',
      organization: 'test-org',
      project_name: 'orders',
      token: 'read-token',
    })
    expect(loadSavedReadToken(dir, { organization: 'test-org', projectName: 'orders' })).toEqual({
      baseUrl: 'https://logfire-us.pydantic.dev',
      token: 'read-token',
    })
    // A different project must not see it -- `projects use` repoints the directory, and a
    // token left from the previous project would otherwise be sent for the new one.
    expect(loadSavedReadToken(dir, { organization: 'test-org', projectName: 'other-project' })).toBeUndefined()
  })

  it('treats a missing expiry as unbounded, not invalid', () => {
    const dir = makeTmpDir()
    writeFileSync(
      readTokenPath(dir),
      JSON.stringify({ base_url: 'https://logfire-us.pydantic.dev', organization: 'test-org', project_name: 'orders', token: 'read-token' })
    )

    expect(loadSavedReadToken(dir, { organization: 'test-org', projectName: 'orders' })).toEqual({
      baseUrl: 'https://logfire-us.pydantic.dev',
      token: 'read-token',
    })
  })

  it.each([
    [{ organization: 'other-org' }, 'issued for a different organization'],
    [{ project_name: 'other-project' }, 'issued for a different project'],
    [{ expires_at: '2000-01-01T00:00:00Z' }, 'already expired'],
    [{ expires_at: 'not-a-timestamp' }, 'unparseable expiry'],
    [{ token: '' }, 'empty token'],
    [{ token: undefined }, 'no token key'],
    [{ base_url: undefined }, 'no base_url key'],
  ])('rejects a saved token that is unusable: %j (%s)', (override, _reason) => {
    const dir = makeTmpDir()
    const base = {
      base_url: 'https://logfire-us.pydantic.dev',
      expires_at: '2099-12-31T23:59:59Z',
      organization: 'test-org',
      project_name: 'orders',
      token: 'read-token',
    }
    writeFileSync(readTokenPath(dir), JSON.stringify({ ...base, ...override }))

    expect(loadSavedReadToken(dir, { organization: 'test-org', projectName: 'orders' })).toBeUndefined()
  })

  it('writes the saved token readable only by its owner', () => {
    const dir = makeTmpDir()
    saveReadToken(dir, {
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiresAt: new Date(),
      organization: 'test-org',
      projectName: 'orders',
      token: 'read-token',
    })

    expect(statSync(readTokenPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('refuses to follow a symlink at the saved-token destination', () => {
    const dir = makeTmpDir()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'important')
    symlinkSync(victim, readTokenPath(dir))

    expect(() =>
      saveReadToken(dir, {
        baseUrl: 'https://logfire-us.pydantic.dev',
        expiresAt: new Date(),
        organization: 'test-org',
        projectName: 'orders',
        token: 'read-token',
      })
    ).toThrow(LogfireCliError)
    expect(readFileSync(victim, 'utf8')).toBe('important')
  })

  it('refuses to write through a symlinked data directory', () => {
    // `O_NOFOLLOW` on the final `openSync` call only protects `read_token.json` itself --
    // a committed `.logfire` that is ITSELF a symlink (to a tracked directory, or one CI
    // collects artifacts from) would sail past that check entirely, since `dataDir`'s
    // existence is checked with `statSync`, which follows symlinks.
    const parent = makeTmpDir()
    const victim = makeTmpDir()
    const dataDir = join(parent, '.logfire')
    symlinkSync(victim, dataDir)

    expect(() =>
      saveReadToken(dataDir, {
        baseUrl: 'https://logfire-us.pydantic.dev',
        expiresAt: new Date(),
        organization: 'test-org',
        projectName: 'orders',
        token: 'read-token',
      })
    ).toThrow(LogfireCliError)
    expect(existsSync(join(victim, 'read_token.json'))).toBe(false)
  })

  it('narrows an existing permissive file before writing, not after', () => {
    const dir = makeTmpDir()
    writeFileSync(readTokenPath(dir), '{}')
    chmodSync(readTokenPath(dir), 0o644)

    saveReadToken(dir, {
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiresAt: new Date(),
      organization: 'test-org',
      projectName: 'orders',
      token: 'read-token',
    })

    // The mode passed to `openSync` only applies when it CREATES the file, so a file that
    // already existed keeps its old permissions unless something explicitly narrows them.
    expect(statSync(readTokenPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('removes the saved read token as part of removing project credentials', () => {
    const dir = makeTmpDir()
    writeProjectCredentials(dir, {
      logfire_api_url: 'https://logfire-us.pydantic.dev',
      project_name: 'orders',
      project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
      token: 'write-token',
    })
    saveReadToken(dir, {
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiresAt: new Date(),
      organization: 'test-org',
      projectName: 'orders',
      token: 'read-token',
    })

    removeProjectCredentials(dir)

    expect(readProjectCredentials(dir)).toBeUndefined()
    expect(loadSavedReadToken(dir, { organization: 'test-org', projectName: 'orders' })).toBeUndefined()
  })

  it('seeds .gitignore when saveReadToken creates the data directory itself', () => {
    // `saveReadToken` calls the same `ensureDataDir` as `writeProjectCredentials`, but
    // exercised on its own: `read-tokens create --save` can run before `projects use` has
    // ever created the directory (an explicit `--project` needs no linked directory at
    // all), so this path has to seed `.gitignore` too, not only the project-credentials one.
    const dir = join(makeTmpDir(), 'nested', '.logfire')
    saveReadToken(dir, {
      baseUrl: 'https://logfire-us.pydantic.dev',
      expiresAt: new Date(),
      organization: 'test-org',
      projectName: 'orders',
      token: 'read-token',
    })

    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*')
  })

  it('derives the organization from a project URL', () => {
    expect(organizationFromProjectUrl('https://logfire-us.pydantic.dev/test-org/orders')).toBe('test-org')
    expect(organizationFromProjectUrl('https://logfire-us.pydantic.dev/test-org/orders/')).toBe('test-org')
    expect(organizationFromProjectUrl('https://logfire-us.pydantic.dev/orders')).toBeUndefined()
    expect(organizationFromProjectUrl('not a url')).toBeUndefined()
  })

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'logfire-cli-credentials-'))
    tmpDirs.push(dir)
    return dir
  }
})
