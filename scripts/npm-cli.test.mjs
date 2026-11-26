import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const sdkManifest = new URL('../packages/logfire-api/package.json', import.meta.url)
const load = createRequire(sdkManifest)
const { version: sdkVersion, bin } = JSON.parse(readFileSync(sdkManifest, 'utf8'))
const { version: cliVersion } = load('logfire-cli/package.json')
const entry = fileURLToPath(new URL(bin.logfire, sdkManifest))

function run(...args) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30_000 })
  assert.ifError(result.error)
  return result
}

test('the built npm bin reports both package versions', () => {
  const result = run('--version')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split(/\r?\n/u).join('\n'), `logfire-cli ${cliVersion}\nLogfire JavaScript SDK ${sdkVersion}`)
})

test('the built npm bin forwards native usage errors', () => {
  const result = run('wizard', '--not-an-option')
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^Usage: logfire wizard /mu)
})
