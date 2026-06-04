/* eslint-disable @typescript-eslint/require-await -- test stubs satisfy async signatures without awaiting. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { Prompt } from './interactivePrompt'
import { runCli } from './index'

describe('CLI entrypoint', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('prints help without excluded Python commands', async () => {
    const stdout = new MemoryOutput()

    await expect(runCli(['--help'], { stdout })).resolves.toBe(0)

    expect(stdout.text()).toContain('auth')
    expect(stdout.text()).toContain('projects')
    expect(stdout.text()).not.toMatch(/^  run\s/mu)
    expect(stdout.text()).not.toMatch(/^  inspect\s/mu)
    expect(stdout.text()).not.toMatch(/^  gateway\s/mu)
  })

  it('prints read-tokens help for no args without requiring --project', async () => {
    const stdout = new MemoryOutput()
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(runCli(['read-tokens'], { fetch: fetchImpl, homeDir: makeTmpDir(), stdout })).resolves.toBe(0)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(stdout.text()).toContain('read-tokens --project')
  })

  it('rejects unexpected auth arguments instead of starting the flow', async () => {
    const stderr = new MemoryOutput()
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(runCli(['auth', 'bogus'], { fetch: fetchImpl, homeDir: makeTmpDir(), stderr })).resolves.toBe(1)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(stderr.text()).toContain('Unexpected argument bogus')
  })

  it('authenticates and writes global user credentials', async () => {
    const homeDir = makeTmpDir()
    const stderr = new MemoryOutput()
    const openBrowser = vi.fn<(_url: string) => void>()
    const fetchImpl = fetchSequence([
      jsonResponse({ device_code: 'DC', frontend_auth_url: 'https://example.com/auth' }),
      jsonResponse({ expiration: '2099-12-31T23:59:59Z', token: 'user-token' }),
    ])

    await expect(
      runCli(['--region', 'us', 'auth'], {
        fetch: fetchImpl,
        homeDir,
        openBrowser,
        prompt: promptWithDefaults(),
        stderr,
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(0)

    expect(openBrowser).toHaveBeenCalledWith('https://example.com/auth')
    expect(readFileSync(join(homeDir, '.logfire/default.toml'), 'utf8')).toBe(
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )
    expect(stderr.text()).toContain('Successfully authenticated!')
  })

  it('configures an existing project and writes local credentials', async () => {
    const cwd = makeTmpDir()
    const homeDir = makeTmpDir()
    mkdirSync(join(homeDir, '.logfire'))
    writeFileSync(
      join(homeDir, '.logfire/default.toml'),
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )

    await expect(
      runCli(['--region', 'us', 'projects', 'use', 'myproject'], {
        cwd,
        fetch: fetchSequence([
          jsonResponse([
            { organization_name: 'fake_org', project_name: 'myproject' },
            { organization_name: 'fake_org', project_name: 'otherproject' },
          ]),
          jsonResponse({ project_name: 'myproject', project_url: 'fake_project_url', token: 'fake_token' }),
        ]),
        homeDir,
        prompt: promptWithDefaults(),
        stderr: new MemoryOutput(),
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(0)

    expect(JSON.parse(readFileSync(join(cwd, '.logfire/logfire_credentials.json'), 'utf8'))).toEqual({
      logfire_api_url: 'https://logfire-us.pydantic.dev',
      project_name: 'myproject',
      project_url: 'fake_project_url',
      token: 'fake_token',
    })
  })

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'logfire-cli-entry-'))
    tmpDirs.push(dir)
    return dir
  }
})

class MemoryOutput extends Writable {
  private readonly chunks: string[] = []

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    callback()
  }

  text(): string {
    return this.chunks.join('')
  }
}

function promptWithDefaults(): Prompt {
  return {
    choice: async (_message: string, _choices: readonly string[], defaultChoice?: string) => defaultChoice ?? '1',
    confirm: async () => true,
    text: async (_message: string, defaultValue?: string) => defaultValue ?? 'myproject',
    waitForEnter: async () => undefined,
  }
}

function fetchSequence(responses: Response[]): typeof fetch {
  return vi.fn<typeof fetch>(async () => {
    const response = responses.shift()
    if (response === undefined) {
      throw new Error('Unexpected fetch call')
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
