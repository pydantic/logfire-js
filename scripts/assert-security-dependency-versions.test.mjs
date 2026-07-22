import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assertionScript = resolve(repositoryRoot, 'scripts/assert-security-dependency-versions.mjs')
const workspacePath = resolve(repositoryRoot, 'pnpm-workspace.yaml')
const lockfilePath = resolve(repositoryRoot, 'pnpm-lock.yaml')

function replaceExactlyOnce(text, before, after) {
  const first = text.indexOf(before)
  if (first === -1 || text.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one fixture occurrence of ${JSON.stringify(before)}`)
  }
  return text.replace(before, after)
}

function replaceFirst(text, before, after) {
  if (!text.includes(before)) throw new Error(`Fixture does not contain ${JSON.stringify(before)}`)
  return text.replace(before, after)
}

async function expectUnsafeFixture({ expected, lockfile, workspace }) {
  const directory = await mkdtemp(join(tmpdir(), 'logfire-security-dependencies-'))
  try {
    const fixtureWorkspace = join(directory, 'pnpm-workspace.yaml')
    const fixtureLockfile = join(directory, 'pnpm-lock.yaml')
    await Promise.all([writeFile(fixtureWorkspace, workspace), writeFile(fixtureLockfile, lockfile)])
    const result = spawnSync(process.execPath, [assertionScript, '--workspace', fixtureWorkspace, '--lockfile', fixtureLockfile], {
      encoding: 'utf8',
    })
    if (result.status === 0 || !result.stderr.includes(expected)) {
      throw new Error(`Unsafe fixture did not fail with ${JSON.stringify(expected)}:\n${result.stdout}${result.stderr}`)
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

execFileSync(process.execPath, [assertionScript], { stdio: 'inherit' })

const [workspace, lockfile] = await Promise.all([readFile(workspacePath, 'utf8'), readFile(lockfilePath, 'utf8')])
const fixtures = [
  {
    expected: 'js-yaml catalog declares vulnerable version ^4.2.0',
    workspace: replaceExactlyOnce(workspace, "  'js-yaml': ^4.3.0", "  'js-yaml': ^4.2.0"),
  },
  {
    expected: '@changesets/parse>js-yaml override declares vulnerable version 4.2.0',
    workspace: replaceExactlyOnce(workspace, "  '@changesets/parse>js-yaml': '4.3.0'", "  '@changesets/parse>js-yaml': '4.2.0'"),
  },
  {
    expected: 'read-yaml-file>js-yaml override declares vulnerable version 4.2.0',
    workspace: replaceExactlyOnce(workspace, "  'read-yaml-file@2.1.0>js-yaml': '4.3.0'", "  'read-yaml-file@2.1.0>js-yaml': '4.2.0'"),
  },
  {
    expected: '@opentelemetry/sdk-node catalog declares vulnerable version >=0.219.0',
    workspace: replaceExactlyOnce(
      workspace,
      "  '@opentelemetry/sdk-node': '>=0.220.0 <0.300.0'",
      "  '@opentelemetry/sdk-node': '>=0.219.0 <0.300.0'"
    ),
  },
  {
    expected: '@opentelemetry/sdk-node catalog must use one bounded range; found >=0.220.0 <0.300.0 || 0.219.0',
    workspace: replaceExactlyOnce(
      workspace,
      "  '@opentelemetry/sdk-node': '>=0.220.0 <0.300.0'",
      "  '@opentelemetry/sdk-node': '>=0.220.0 <0.300.0 || 0.219.0'"
    ),
  },
  {
    expected: 'js-yaml resolves vulnerable version 4.2.0',
    lockfile: replaceFirst(lockfile, '  js-yaml@4.3.0:\n', '  js-yaml@4.2.0:\n'),
  },
  {
    expected: '@opentelemetry/sdk-node resolves vulnerable version 0.219.0',
    lockfile: replaceFirst(lockfile, "  '@opentelemetry/sdk-node@0.220.0':\n", "  '@opentelemetry/sdk-node@0.219.0':\n"),
  },
  {
    expected: '@opentelemetry/propagator-jaeger resolves vulnerable version 2.8.0',
    lockfile: replaceFirst(lockfile, "  '@opentelemetry/propagator-jaeger@2.9.0':\n", "  '@opentelemetry/propagator-jaeger@2.8.0':\n"),
  },
]

for (const fixture of fixtures) {
  await expectUnsafeFixture({ lockfile, workspace, ...fixture })
}

console.log('Security dependency assertion rejects every vulnerable fixture')
