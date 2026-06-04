import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vite-plus/test'

import {
  UserTokenCollection,
  formatUserToken,
  parseUserTokensToml,
  projectCredentialsPath,
  readProjectCredentials,
  stringifyUserTokensToml,
  writeProjectCredentials,
} from './credentials'

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

  it('writes and reads local project credentials', () => {
    const dir = makeTmpDir()
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

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'logfire-cli-credentials-'))
    tmpDirs.push(dir)
    return dir
  }
})
