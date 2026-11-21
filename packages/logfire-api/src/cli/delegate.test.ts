import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { runNativeCli } from './delegate'

describe('native CLI delegation', () => {
  let root: string
  let load: NodeJS.Require

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'logfire cli '))
    load = createRequire(join(root, 'sdk.cjs'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function writeManifest(json: string): string {
    const directory = join(root, 'node_modules', 'logfire-cli')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), json)
    return directory
  }

  it('uses the declared bin and preserves quoted arguments and failure status', () => {
    const directory = writeManifest('{"type":"module","bin":{"logfire":"alternate launch.js"}}')
    writeFileSync(
      join(directory, 'alternate launch.js'),
      `import assert from 'node:assert/strict'
assert.deepEqual(process.argv.slice(2), ['--arg', 'value with "quotes"'])
assert.equal(process.env.LOGFIRE_CLI_SDK_VERSION, '0.26.2')
assert.equal(process.env.LOGFIRE_CLI_COMMAND_NAME, 'logfire')
process.exitCode = 23
`
    )
    const parentVersion = process.env['LOGFIRE_CLI_SDK_VERSION']
    const parentCommand = process.env['LOGFIRE_CLI_COMMAND_NAME']

    expect(runNativeCli(['--arg', 'value with "quotes"'], '0.26.2', load)).toBe(23)
    expect(process.env['LOGFIRE_CLI_SDK_VERSION']).toBe(parentVersion)
    expect(process.env['LOGFIRE_CLI_COMMAND_NAME']).toBe(parentCommand)
  })

  it('explains an absent optional dependency', () => {
    const writeError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const lookup = vi.spyOn(load, 'resolve').mockImplementation(() => {
      throw Object.assign(new Error('Optional package is not installed'), { code: 'MODULE_NOT_FOUND' })
    })

    expect(runNativeCli([], '0.26.2', load)).toBe(1)
    expect(lookup).toHaveBeenCalledExactlyOnceWith('logfire-cli/package.json')
    expect(writeError).toHaveBeenCalledExactlyOnceWith('Logfire CLI is unavailable. Install optional dependencies on a supported platform.')
  })

  it('does not report an installed package without a bin as an omitted dependency', () => {
    writeManifest('{}')

    expect(() => runNativeCli([], '0.26.2', load)).toThrow('The installed logfire-cli package does not declare a logfire command.')
  })

  it('does not hide other resolution failures', () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    vi.spyOn(load, 'resolve').mockImplementation(() => {
      throw denied
    })

    expect(() => runNativeCli([], '0.26.2', load)).toThrow(denied)
  })
})
