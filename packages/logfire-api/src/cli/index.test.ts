/* eslint-disable @typescript-eslint/require-await -- test stubs satisfy async signatures without awaiting. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

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

  it('rejects a blank --base-url value', async () => {
    const stderr = new MemoryOutput()
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(runCli(['--base-url=', 'whoami'], { fetch: fetchImpl, homeDir: makeTmpDir(), stderr })).resolves.toBe(1)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(stderr.text()).toContain('The --base-url value cannot be empty.')
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

  it('authenticates through the REAL prompt from one piped multi-line answer, region and Enter together', async () => {
    // No `prompt` override: this drives `auth` through the actual `createPrompt`, not a
    // fake, so it is the one test in this file that would have caught the original bug --
    // a real agent, following the shipped prompt's literal `npx logfire auth`, found that
    // `printf '1\n\n' | npx logfire auth` hung forever on the second (Enter) prompt.
    await withTimeout(async () => {
      const homeDir = makeTmpDir()
      const stderr = new MemoryOutput()
      const openBrowser = vi.fn<(_url: string) => void>()
      const fetchImpl = fetchSequence([
        jsonResponse({ device_code: 'DC', frontend_auth_url: 'https://example.com/auth' }),
        jsonResponse({ expiration: '2099-12-31T23:59:59Z', token: 'user-token' }),
      ])
      const stdin = new PassThrough()
      stdin.end('1\n\n')

      await expect(runCli(['auth'], { fetch: fetchImpl, homeDir, openBrowser, stderr, stdin, stdout: new MemoryOutput() })).resolves.toBe(0)

      expect(readFileSync(join(homeDir, '.logfire/default.toml'), 'utf8')).toBe(
        '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
      )
    })
  })

  it('names the region commands instead of hanging when stdin has nothing to read', async () => {
    // Mirrors pydantic/logfire#2275's own non-interactive test: no `--region`, and stdin
    // closed immediately (matching `< /dev/null`, or the pipe Claude Code's own Bash tool
    // gives a spawned command) -- the region choice has no default to fall back to, so
    // this is the one case that has to fail, and it must fail by saying what to run.
    await withTimeout(async () => {
      const stderr = new MemoryOutput()
      const fetchImpl = vi.fn<typeof fetch>()
      const stdin = new PassThrough()
      stdin.end('')

      await expect(runCli(['auth'], { fetch: fetchImpl, homeDir: makeTmpDir(), stderr, stdin, stdout: new MemoryOutput() })).resolves.toBe(
        1
      )

      expect(fetchImpl).not.toHaveBeenCalled()
      expect(stderr.text()).toContain('logfire --region us auth')
      expect(stderr.text()).toContain('logfire --region eu auth')
    })
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

  it('read-tokens create --save writes the file and prints nothing, falling back to the linked project', async () => {
    const cwd = makeTmpDir()
    const homeDir = makeTmpDir()
    mkdirSync(join(homeDir, '.logfire'))
    writeFileSync(
      join(homeDir, '.logfire/default.toml'),
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: 'https://logfire-us.pydantic.dev',
        project_name: 'orders',
        project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
        token: 'fake-write-token',
      })
    )

    const stdout = new MemoryOutput()
    const stderr = new MemoryOutput()
    await expect(
      runCli(['read-tokens', 'create', '--save'], {
        cwd,
        fetch: fetchSequence([jsonResponse({ token: 'saved-read-token' })]),
        homeDir,
        stderr,
        stdout,
      })
    ).resolves.toBe(0)

    expect(stdout.text()).toBe('')
    expect(stderr.text()).not.toContain('saved-read-token')
    expect(stderr.text()).toContain('test-org/orders')

    const saved = JSON.parse(readFileSync(join(cwd, '.logfire/read_token.json'), 'utf8')) as Record<string, unknown>
    expect(saved['token']).toBe('saved-read-token')
    expect(saved['organization']).toBe('test-org')
    expect(saved['project_name']).toBe('orders')
    expect(saved['base_url']).toBe('https://logfire-us.pydantic.dev')
  })

  it('read-tokens create --save never mints a token if the destination cannot be reserved first', async () => {
    // A read token cannot be revoked or displayed once created. If the destination is
    // checked only AFTER minting, a symlinked `.logfire` (or a read-only data directory)
    // leaves a real, orphaned server-side credential behind with no way to see or undo
    // it. Reserving the destination first means that failure happens before the mint
    // ever has a chance to run at all -- proven here by asserting `fetch` (the mint's
    // only network call in this flow) is never even invoked.
    const cwd = makeTmpDir()
    const homeDir = makeTmpDir()
    mkdirSync(join(homeDir, '.logfire'))
    writeFileSync(
      join(homeDir, '.logfire/default.toml'),
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )
    // A symlinked data directory, with an explicit --project so `readProjectCredentials`
    // is never consulted -- otherwise ITS OWN "no credentials found" failure (reading
    // through the same symlink to a directory with nothing in it) would exit 1 and skip
    // `fetch` regardless of ordering, and the test would pass without the fix it exists to
    // pin down.
    const victim = makeTmpDir()
    symlinkSync(victim, join(cwd, '.logfire'))

    // A real response, not a bare `vi.fn()`: if the mint DID run before the reserve
    // check, an un-stubbed fetch would throw its own `TypeError` reading `.ok` off
    // `undefined`, which fails this test for the wrong reason -- masking the ordering bug
    // as a crash instead of a clean "fetch was called when it should not have been".
    const fetchImpl = fetchSequence([jsonResponse({ token: 'newly-minted-token' })])
    await expect(
      runCli(['read-tokens', 'create', '--project', 'test-org/orders', '--save'], {
        cwd,
        fetch: fetchImpl,
        homeDir,
        stderr: new MemoryOutput(),
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(1)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(existsSync(join(victim, 'read_token.json'))).toBe(false)
  })

  it('read-tokens create without --save prints the token and writes no file', async () => {
    const cwd = makeTmpDir()
    const homeDir = makeTmpDir()
    mkdirSync(join(homeDir, '.logfire'))
    writeFileSync(
      join(homeDir, '.logfire/default.toml'),
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )

    const stdout = new MemoryOutput()
    await expect(
      runCli(['read-tokens', '--project', 'test-org/orders', 'create'], {
        cwd,
        fetch: fetchSequence([jsonResponse({ token: 'printed-token' })]),
        homeDir,
        stderr: new MemoryOutput(),
        stdout,
      })
    ).resolves.toBe(0)

    expect(stdout.text()).toBe('printed-token\n')
    expect(() => readFileSync(join(cwd, '.logfire/read_token.json'), 'utf8')).toThrow('ENOENT')
  })

  it('read-tokens create --save with an explicit --project needs no linked directory', async () => {
    const cwd = makeTmpDir()
    const homeDir = makeTmpDir()
    mkdirSync(join(homeDir, '.logfire'))
    writeFileSync(
      join(homeDir, '.logfire/default.toml'),
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )
    // Deliberately no `.logfire/logfire_credentials.json` in cwd: --project bypasses the
    // linked-directory fallback entirely.

    await expect(
      runCli(['read-tokens', '--project', 'other-org/other-project', 'create', '--save'], {
        cwd,
        fetch: fetchSequence([jsonResponse({ token: 'explicit-project-token' })]),
        homeDir,
        stderr: new MemoryOutput(),
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(0)

    const saved = JSON.parse(readFileSync(join(cwd, '.logfire/read_token.json'), 'utf8')) as Record<string, unknown>
    expect(saved['organization']).toBe('other-org')
    expect(saved['project_name']).toBe('other-project')
  })

  it('read-tokens create --save run twice replaces the stale token, not merges with it', async () => {
    const cwd = makeTmpDir()
    const homeDir = makeTmpDir()
    mkdirSync(join(homeDir, '.logfire'))
    writeFileSync(
      join(homeDir, '.logfire/default.toml'),
      '[tokens."https://logfire-us.pydantic.dev"]\ntoken = "user-token"\nexpiration = "2099-12-31T23:59:59Z"\n'
    )
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: 'https://logfire-us.pydantic.dev',
        project_name: 'orders',
        project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
        token: 'fake-write-token',
      })
    )
    // A long, stale token: dropping symlink-safe truncation would leave trailing bytes
    // from this behind, and a same-length fresh token would not expose that.
    writeFileSync(
      join(cwd, '.logfire/read_token.json'),
      JSON.stringify({
        base_url: 'https://logfire-us.pydantic.dev',
        organization: 'test-org',
        project_name: 'orders',
        token: `stale-token-${'x'.repeat(200)}`,
      })
    )

    await expect(
      runCli(['read-tokens', 'create', '--save'], {
        cwd,
        fetch: fetchSequence([jsonResponse({ token: 'fresh-token' })]),
        homeDir,
        stderr: new MemoryOutput(),
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(0)

    const saved = JSON.parse(readFileSync(join(cwd, '.logfire/read_token.json'), 'utf8')) as Record<string, unknown>
    expect(saved['token']).toBe('fresh-token')
  })

  it('clean lists the saved read token in the confirmation prompt, and removes it on confirm', async () => {
    // Approving deletion should not silently remove a credential the prompt never
    // mentioned -- the read token is deleted by `removeProjectCredentials` just like the
    // write-token credentials file, so it has to be named alongside it.
    const cwd = makeTmpDir()
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: 'https://logfire-us.pydantic.dev',
        project_name: 'orders',
        project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
        token: 'fake-write-token',
      })
    )
    writeFileSync(
      join(cwd, '.logfire/read_token.json'),
      JSON.stringify({ base_url: 'https://logfire-us.pydantic.dev', organization: 'test-org', project_name: 'orders', token: 'read-token' })
    )

    let confirmMessage = ''
    const prompt: Prompt = {
      ...promptWithDefaults(),
      confirm: async (message) => {
        confirmMessage = message
        return true
      },
    }

    await expect(
      runCli(['clean'], { cwd, homeDir: makeTmpDir(), prompt, stderr: new MemoryOutput(), stdout: new MemoryOutput() })
    ).resolves.toBe(0)

    expect(confirmMessage).toContain('read_token.json')
    expect(existsSync(join(cwd, '.logfire/read_token.json'))).toBe(false)
  })

  it('projects status without a saved token says what to run, without calling the API', async () => {
    const cwd = makeTmpDir()
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: 'https://logfire-us.pydantic.dev',
        project_name: 'orders',
        project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
        token: 'fake-write-token',
      })
    )

    const stderr = new MemoryOutput()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(runCli(['projects', 'status'], { cwd, fetch: fetchImpl, stderr, stdout: new MemoryOutput() })).resolves.toBe(1)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(stderr.text()).toContain('read-tokens create --save')
  })

  it('projects status renders one row per service and never displays the read token', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })

    const stderr = new MemoryOutput()
    await expect(
      runCli(['projects', 'status'], {
        cwd,
        fetch: fetchSequence([
          jsonResponse({
            data: [
              { last_seen: '2026-08-19T01:00:00.000Z', records: 87, service_name: 'orders-web' },
              { last_seen: '2026-08-19T01:00:05.000Z', records: 84, service_name: 'orders-worker' },
            ],
          }),
        ]),
        stderr,
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(0)

    const text = stderr.text()
    expect(text).toContain('test-org/orders')
    expect(text).toContain('orders-web')
    expect(text).toContain('orders-worker')
    expect(text).toContain('87')
    expect(text).not.toContain('fake-read-token')
  })

  it('projects status --json puts the same data on stdout', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })

    const stdout = new MemoryOutput()
    await expect(
      runCli(['projects', 'status', '--json'], {
        cwd,
        fetch: fetchSequence([
          jsonResponse({ data: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 87, service_name: 'orders-web' }] }),
        ]),
        stderr: new MemoryOutput(),
        stdout,
      })
    ).resolves.toBe(0)

    expect(JSON.parse(stdout.text())).toEqual({
      lookback_hours: 1,
      organization: 'test-org',
      project_name: 'orders',
      project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
      services: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 87, service_name: 'orders-web' }],
    })
  })

  it('projects status reports "not yet" rather than failure when nothing has arrived', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })

    const stderr = new MemoryOutput()
    await expect(
      runCli(['projects', 'status'], { cwd, fetch: fetchSequence([jsonResponse({ data: [] })]), stderr, stdout: new MemoryOutput() })
    ).resolves.toBe(0)

    expect(stderr.text()).toContain('No telemetry in the last 1h')
  })

  it('ignores a malicious logfire_api_url and queries the host the token was saved with', async () => {
    // `logfire_credentials.json` lives inside the project this command runs in, so a
    // tampered repository can set `logfire_api_url` to anything. If that value controlled
    // where the read token were sent, checking out an untrusted repo and running `projects
    // status` in it would hand the token straight to an attacker.
    const cwd = makeTmpDir()
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: 'https://attacker.example.com',
        project_name: 'orders',
        project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
        token: 'fake-write-token',
      })
    )
    writeFileSync(
      join(cwd, '.logfire/read_token.json'),
      JSON.stringify({
        base_url: 'https://logfire-us.pydantic.dev',
        organization: 'test-org',
        project_name: 'orders',
        token: 'fake-read-token',
      })
    )

    const requestedHosts: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      requestedHosts.push(new URL(input instanceof Request ? input.url : input.toString()).host)
      return jsonResponse({ data: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 1, service_name: 'orders-web' }] })
    })

    await expect(
      runCli(['projects', 'status'], { cwd, fetch: fetchImpl, stderr: new MemoryOutput(), stdout: new MemoryOutput() })
    ).resolves.toBe(0)

    expect(requestedHosts).toEqual(['logfire-us.pydantic.dev'])
  })

  it('queries a self-hosted deployment using the saved base URL, not a region guess', async () => {
    // An earlier design derived the query host from the token's own region prefix, which
    // closed the exfiltration path above but would have silently misrouted a self-hosted
    // deployment: its base URL cannot be recovered from the token, only from where it was
    // actually minted.
    const cwd = makeTmpDir()
    linkProject(cwd, {
      baseUrl: 'https://logfire.example.com',
      readToken: 'fake-read-token',
      projectUrl: 'https://logfire.example.com/test-org/orders',
    })

    const requestedHosts: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      requestedHosts.push(new URL(input instanceof Request ? input.url : input.toString()).host)
      return jsonResponse({ data: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 1, service_name: 'orders-web' }] })
    })

    await expect(
      runCli(['projects', 'status'], { cwd, fetch: fetchImpl, stderr: new MemoryOutput(), stdout: new MemoryOutput() })
    ).resolves.toBe(0)

    expect(requestedHosts).toEqual(['logfire.example.com'])
  })

  it('reports a network failure cleanly instead of an unhandled rejection', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await Promise.resolve()
      throw new Error('connect ECONNREFUSED')
    })

    const stderr = new MemoryOutput()
    await expect(runCli(['projects', 'status'], { cwd, fetch: fetchImpl, stderr, stdout: new MemoryOutput() })).resolves.toBe(1)
    expect(stderr.text()).toContain('Could not reach https://logfire-us.pydantic.dev')
  })

  it('rejects a non-200 response cleanly', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })

    const stderr = new MemoryOutput()
    await expect(
      runCli(['projects', 'status'], {
        cwd,
        fetch: fetchSequence([new Response(null, { status: 204 })]),
        stderr,
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(1)
    expect(stderr.text()).toContain('Could not read the project: 204')
  })

  it('rejects a malformed 200 response body cleanly', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })

    const stderr = new MemoryOutput()
    await expect(
      runCli(['projects', 'status'], {
        cwd,
        fetch: fetchSequence([new Response('not json', { status: 200 })]),
        stderr,
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(1)
    expect(stderr.text()).toContain('unexpected response shape')
  })

  it('strips control characters from a service name before writing to the terminal', async () => {
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })
    const evilName = 'evil\x1b[2Korders-web\x9btest'

    const stderr = new MemoryOutput()
    await expect(
      runCli(['projects', 'status'], {
        cwd,
        fetch: fetchSequence([jsonResponse({ data: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 1, service_name: evilName }] })]),
        stderr,
        stdout: new MemoryOutput(),
      })
    ).resolves.toBe(0)

    const text = stderr.text()
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain('\x9b')
  })

  it('does not need control-character stripping in --json mode: JSON.stringify already escapes them', async () => {
    // Pins that nobody "fixes" this by routing --json through the same stripping the
    // table uses, which would mangle legitimate unicode service names for no reason: a
    // JSON string escapes control characters (as `\u001b`, not a literal ESC byte) by
    // construction, so the raw value is safe here without help.
    const cwd = makeTmpDir()
    linkProject(cwd, { baseUrl: 'https://logfire-us.pydantic.dev', readToken: 'fake-read-token' })
    const evilName = 'evil\x1b[2Korders-web'

    const stdout = new MemoryOutput()
    await expect(
      runCli(['projects', 'status', '--json'], {
        cwd,
        fetch: fetchSequence([jsonResponse({ data: [{ last_seen: '2026-08-19T01:00:00.000Z', records: 1, service_name: evilName }] })]),
        stderr: new MemoryOutput(),
        stdout,
      })
    ).resolves.toBe(0)

    const raw = stdout.text()
    expect(raw).not.toContain('\x1b')
    expect(raw).toContain('\\u001b')
    expect((JSON.parse(raw) as { services: { service_name: string }[] }).services[0]?.service_name).toBe(evilName)
  })

  it('strips control characters from the project name in the status header', async () => {
    // `organization`/`project_name`/`project_url` come from `logfire_credentials.json`,
    // a file inside the project this command runs in -- the same threat model
    // `saveReadToken`'s own doc comment already applies to `base_url`, and the same
    // untrusted-text reasoning as a telemetry-supplied service name.
    const cwd = makeTmpDir()
    const evilName = 'orders\x1b[2Kevil'
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: 'https://logfire-us.pydantic.dev',
        project_name: evilName,
        project_url: 'https://logfire-us.pydantic.dev/test-org/orders',
        token: 'fake-write-token',
      })
    )
    writeFileSync(
      join(cwd, '.logfire/read_token.json'),
      JSON.stringify({
        base_url: 'https://logfire-us.pydantic.dev',
        organization: 'test-org',
        project_name: evilName,
        token: 'fake-read-token',
      })
    )

    const stderr = new MemoryOutput()
    await expect(
      runCli(['projects', 'status'], { cwd, fetch: fetchSequence([jsonResponse({ data: [] })]), stderr, stdout: new MemoryOutput() })
    ).resolves.toBe(0)

    expect(stderr.text()).not.toContain('\x1b')
  })

  function linkProject(cwd: string, options: { baseUrl: string; projectUrl?: string; readToken: string }): void {
    mkdirSync(join(cwd, '.logfire'), { recursive: true })
    writeFileSync(
      join(cwd, '.logfire/logfire_credentials.json'),
      JSON.stringify({
        logfire_api_url: options.baseUrl,
        project_name: 'orders',
        project_url: options.projectUrl ?? `${options.baseUrl}/test-org/orders`,
        token: 'fake-write-token',
      })
    )
    writeFileSync(
      join(cwd, '.logfire/read_token.json'),
      JSON.stringify({ base_url: options.baseUrl, organization: 'test-org', project_name: 'orders', token: options.readToken })
    )
  }

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

/** For tests that drive the REAL prompt (no `prompt` override): a hang there would
 * otherwise fail as a generic test-runner timeout with no indication of which promise
 * never settled. A short, generous race turns that into an assertion failure that names
 * the case -- which is what caught the original bug (`npx logfire auth` hanging on a
 * piped multi-line answer) in the first place. */
async function withTimeout<T>(fn: () => Promise<T>, ms = 2000): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`Timed out after ${String(ms)}ms -- a prompt call likely hung`))
      }, ms)
    }),
  ])
}
