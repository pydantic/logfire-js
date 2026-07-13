import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersions = new Map([
  ['@changesets/cli', '2.30.0'],
  ['@changesets/assemble-release-plan', '6.0.9'],
  ['@changesets/apply-release-plan', '7.1.0'],
])
const browserChangesets = [
  'browser-optional-feature-api',
  'browser-provider-reconfiguration',
  'browser-proxy-example-safety',
  'browser-replay-privacy-defaults',
  'browser-rum-lifecycle',
  'browser-rum-session',
  'browser-rum-web-vitals-metrics',
  'browser-rum-web-vitals',
  'browser-session-replay-integration',
  'stable-browser-rum-lifecycle',
]
const replayChangesets = [
  'browser-optional-feature-api',
  'browser-replay-privacy-defaults',
  'browser-session-replay-integration',
  'replay-delivery-reliability',
  'session-replay-package',
  'stable-browser-rum-lifecycle',
]
const allChangesets = [...new Set([...browserChangesets, ...replayChangesets])].sort()
const expectedReleases = new Map([
  [
    '@pydantic/logfire-browser',
    {
      changesets: browserChangesets,
      newVersion: '0.17.0',
      oldVersion: '0.17.0-alpha.2',
      type: 'minor',
    },
  ],
  [
    '@pydantic/logfire-session-replay',
    {
      changesets: replayChangesets,
      newVersion: '0.1.0',
      oldVersion: '0.1.0-alpha.1',
      type: 'minor',
    },
  ],
  [
    '@pydantic/nextjs-client-side-instrumentation',
    {
      newVersion: '0.1.16',
      oldVersion: '0.1.16-alpha.2',
      type: 'patch',
    },
  ],
])
const expectedModifiedPaths = [
  'examples/nextjs-client-side-instrumentation/CHANGELOG.md',
  'examples/nextjs-client-side-instrumentation/package.json',
  'packages/logfire-browser/CHANGELOG.md',
  'packages/logfire-browser/package.json',
  'packages/logfire-session-replay/CHANGELOG.md',
  'packages/logfire-session-replay/package.json',
].sort()
const autoInstrumentationsSummary =
  'Stabilize browser RUM lifecycle setup with deferred instrumentation factories, opt-in lazy `autoInstrumentations`, provider-owned Web Vitals spans, explicit page URL attributes, and clarified session replay correlation semantics.'

try {
  await verifyReleasePlan()
} catch (error) {
  console.error(`FAIL browser release plan verification: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
}

async function verifyReleasePlan() {
  const tools = resolveChangesetsTools()
  const sourceBefore = await captureSourceState()
  let temporaryRoot
  let primaryError

  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'logfire-browser-release-plan-'))
    const scratchRoot = join(temporaryRoot, 'repository')
    run('git', ['clone', '--local', '--no-hardlinks', '--quiet', repositoryRoot, scratchRoot], repositoryRoot)
    await overlaySourceTree(scratchRoot)
    await linkDependencies(scratchRoot)
    createMainRef(scratchRoot)

    const preJson = JSON.parse(await readFile(join(scratchRoot, '.changeset/pre.json'), 'utf8'))
    check(preJson.mode === 'exit', 'Changesets prerelease mode is not exit')

    const summaries = await readChangesetSummaries(scratchRoot)
    check(equalArrays([...summaries.keys()].sort(), allChangesets), 'Changeset inventory does not match the expected twelve files')

    const scratchBefore = await snapshotTree(scratchRoot)
    const manifestVersionsBefore = await readManifestVersions(scratchRoot)
    const statusPath = join(temporaryRoot, 'status.json')
    run(process.execPath, [tools.cliBin, 'status', '--output', statusPath], scratchRoot)
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    assertStatus(status)

    run(process.execPath, [tools.cliBin, 'version'], scratchRoot)

    const scratchAfter = await snapshotTree(scratchRoot)
    assertGeneratedTree(scratchBefore, scratchAfter)
    await assertManifestVersions(scratchRoot, manifestVersionsBefore)
    await assertGeneratedChangelogs(scratchRoot, summaries)
  } catch (error) {
    primaryError = error
  } finally {
    if (temporaryRoot !== undefined) {
      try {
        await rm(temporaryRoot, { force: true, recursive: true })
        if (await exists(temporaryRoot)) {
          primaryError ??= new Error('temporary release-plan directory survived cleanup')
        }
      } catch {
        primaryError ??= new Error('temporary release-plan directory cleanup failed')
      }
    }
    try {
      const sourceAfter = await captureSourceState()
      if (!equalSourceStates(sourceBefore, sourceAfter)) {
        primaryError = new Error(
          primaryError === undefined
            ? 'source repository changed during disposable verification'
            : `${primaryError instanceof Error ? primaryError.message : 'verification failed'}; source repository also changed`
        )
      }
    } catch {
      primaryError ??= new Error('source-preservation verification failed')
    }
  }

  if (primaryError !== undefined) {
    throw primaryError
  }
  console.log('PASS browser release plan: browser 0.17.0, replay 0.1.0, private client 0.1.16; source preserved')
}

function resolveChangesetsTools() {
  const rootRequire = createRequire(join(repositoryRoot, 'package.json'))
  const cliPackagePath = findPackageJson('@changesets/cli', rootRequire)
  const cliRequire = createRequire(cliPackagePath)
  for (const [name, expectedVersion] of expectedVersions) {
    const packagePath = findPackageJson(name, name === '@changesets/cli' ? rootRequire : cliRequire)
    const packageJson = JSON.parse(readFileSync(packagePath))
    check(packageJson.version === expectedVersion, `${name} must be exactly ${expectedVersion}`)
  }
  const cliPackage = JSON.parse(readFileSync(cliPackagePath))
  const bin = typeof cliPackage.bin === 'string' ? cliPackage.bin : cliPackage.bin?.changeset
  check(typeof bin === 'string', '@changesets/cli does not expose the expected changeset bin')
  return { cliBin: resolve(dirname(cliPackagePath), bin) }
}

function findPackageJson(name, resolver) {
  try {
    return resolver.resolve(`${name}/package.json`)
  } catch {
    let directory = dirname(resolver.resolve(name))
    while (directory !== dirname(directory)) {
      const candidate = join(directory, 'package.json')
      if (existsSync(candidate)) {
        const packageJson = JSON.parse(readFileSync(candidate))
        if (packageJson.name === name) {
          return candidate
        }
      }
      directory = dirname(directory)
    }
    throw new Error(`cannot resolve installed package ${name}`)
  }
}

async function captureSourceState() {
  return {
    head: runBytes('git', ['rev-parse', 'HEAD'], repositoryRoot),
    index: runBytes('git', ['ls-files', '--stage', '-z'], repositoryRoot),
    snapshot: await snapshotSourceFiles(),
    status: runBytes('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryRoot),
  }
}

async function snapshotSourceFiles() {
  const paths = parseNullList(runBytes('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repositoryRoot))
  const snapshot = new Map()
  for (const path of paths) {
    snapshot.set(path, await snapshotPath(join(repositoryRoot, path)))
  }
  return snapshot
}

async function overlaySourceTree(scratchRoot) {
  const sourceTracked = new Set(parseNullList(runBytes('git', ['ls-files', '--cached', '-z'], repositoryRoot)))
  const scratchTracked = parseNullList(runBytes('git', ['ls-files', '--cached', '-z'], scratchRoot))
  for (const path of scratchTracked) {
    if (!sourceTracked.has(path)) {
      await rm(join(scratchRoot, path), { force: true, recursive: true })
    }
  }

  const paths = parseNullList(runBytes('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repositoryRoot))
  for (const path of paths) {
    const sourcePath = join(repositoryRoot, path)
    const targetPath = join(scratchRoot, path)
    let stat
    try {
      stat = await lstat(sourcePath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await rm(targetPath, { force: true, recursive: true })
        continue
      }
      throw error
    }
    await mkdir(dirname(targetPath), { recursive: true })
    await rm(targetPath, { force: true, recursive: true })
    if (stat.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), targetPath)
    } else if (stat.isFile()) {
      await copyFile(sourcePath, targetPath)
    } else {
      throw new Error(`unsupported source path type: ${path}`)
    }
  }
}

async function linkDependencies(scratchRoot) {
  const sourceNodeModules = join(repositoryRoot, 'node_modules')
  check(await exists(sourceNodeModules), 'node_modules is required for release-plan verification')
  await symlink(sourceNodeModules, join(scratchRoot, 'node_modules'), 'dir')
}

function createMainRef(scratchRoot) {
  let mainCommit
  try {
    mainCommit = runText('git', ['rev-parse', '--verify', 'refs/heads/main'], repositoryRoot).trim()
  } catch {
    mainCommit = runText('git', ['rev-parse', 'HEAD'], repositoryRoot).trim()
  }
  run('git', ['update-ref', 'refs/heads/main', mainCommit], scratchRoot)
}

async function readChangesetSummaries(scratchRoot) {
  const summaries = new Map()
  for (const id of allChangesets) {
    const path = join(scratchRoot, `.changeset/${id}.md`)
    const text = await readFile(path, 'utf8')
    const match = /^---\n[\s\S]*?\n---\n\n([\s\S]+)$/u.exec(text)
    check(match !== null, `invalid Changeset format: ${id}`)
    summaries.set(id, normalize(match[1]))
  }
  return summaries
}

function assertStatus(status) {
  check(Array.isArray(status.releases), 'Changesets status did not return releases')
  check(status.preState?.mode === 'exit', 'Changesets status did not report exit mode')
  const nonNoneReleases = status.releases.filter((release) => release.type !== 'none')
  check(nonNoneReleases.length === expectedReleases.size, 'Changesets status returned an unexpected non-none release count')
  const releases = new Map(nonNoneReleases.map((release) => [release.name, release]))
  check(equalArrays([...releases.keys()].sort(), [...expectedReleases.keys()].sort()), 'Changesets status returned unexpected packages')
  for (const [name, expected] of expectedReleases) {
    const actual = releases.get(name)
    check(actual?.type === expected.type, `${name} release type is not ${expected.type}`)
    check(actual?.oldVersion === expected.oldVersion, `${name} old version is not ${expected.oldVersion}`)
    check(actual?.newVersion === expected.newVersion, `${name} new version is not ${expected.newVersion}`)
    check(actual?.newVersion !== null, `${name} has a null version`)
    if (expected.changesets !== undefined) {
      check(equalArrays([...actual.changesets].sort(), [...expected.changesets].sort()), `${name} Changeset selection is incorrect`)
    }
  }
}

function assertGeneratedTree(before, after) {
  const modified = []
  const deleted = []
  const created = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (!before.has(path)) {
      created.push(path)
    } else if (!after.has(path)) {
      deleted.push(path)
    } else if (before.get(path) !== after.get(path)) {
      modified.push(path)
    }
  }
  const expectedDeleted = ['.changeset/pre.json', ...allChangesets.map((id) => `.changeset/${id}.md`)].sort()
  check(equalArrays(modified.sort(), expectedModifiedPaths), 'versioning modified unexpected files')
  check(equalArrays(deleted.sort(), expectedDeleted), 'versioning deleted an unexpected set of files')
  check(created.length === 0, 'versioning created unexpected files')
}

async function assertManifestVersions(scratchRoot, before) {
  const after = await readManifestVersions(scratchRoot)
  check(equalArrays([...before.keys()].sort(), [...after.keys()].sort()), 'manifest path set changed during versioning')
  const expectedTransitions = new Map([
    ['packages/logfire-browser/package.json', ['0.17.0-alpha.2', '0.17.0']],
    ['packages/logfire-session-replay/package.json', ['0.1.0-alpha.1', '0.1.0']],
    ['examples/nextjs-client-side-instrumentation/package.json', ['0.1.16-alpha.2', '0.1.16']],
  ])
  for (const [path, oldVersion] of before) {
    const newVersion = after.get(path)
    check(newVersion !== null, `${path} contains a null version`)
    const expected = expectedTransitions.get(path)
    if (expected === undefined) {
      check(newVersion === oldVersion, `${path} changed version unexpectedly`)
    } else {
      check(oldVersion === expected[0] && newVersion === expected[1], `${path} did not make the expected version transition`)
    }
  }
  check(after.get('examples/nextjs/package.json') === '0.0.0', 'private Next.js example did not remain at 0.0.0')
  check(!(await exists(join(scratchRoot, 'examples/nextjs/CHANGELOG.md'))), 'private Next.js example gained a changelog')
}

async function assertGeneratedChangelogs(scratchRoot, summaries) {
  const browserText = await readFile(join(scratchRoot, 'packages/logfire-browser/CHANGELOG.md'), 'utf8')
  const replayText = await readFile(join(scratchRoot, 'packages/logfire-session-replay/CHANGELOG.md'), 'utf8')
  const privateClientText = await readFile(join(scratchRoot, 'examples/nextjs-client-side-instrumentation/CHANGELOG.md'), 'utf8')
  const browserSection = normalize(extractVersionSection(browserText, '0.17.0'))
  const replaySection = normalize(extractVersionSection(replayText, '0.1.0'))
  const privateClientSection = normalize(extractVersionSection(privateClientText, '0.1.16'))

  for (const id of browserChangesets) {
    check(browserSection.includes(summaries.get(id)), `browser changelog omitted Changeset ${id}`)
  }
  for (const id of replayChangesets) {
    check(replaySection.includes(summaries.get(id)), `replay changelog omitted Changeset ${id}`)
  }
  check(browserSection.includes(normalize(autoInstrumentationsSummary)), 'browser changelog omitted autoInstrumentations')
  check(!replaySection.includes('autoInstrumentations'), 'replay changelog contains browser-only autoInstrumentations prose')
  check(privateClientSection.includes('@pydantic/logfire-browser@0.17.0'), 'private client changelog omitted browser 0.17.0')

  for (const path of await findFiles(scratchRoot, (value) => basename(value) === 'CHANGELOG.md')) {
    const text = await readFile(join(scratchRoot, path), 'utf8')
    check(!/^## null$/mu.test(text), `${path} contains a null changelog version`)
  }
}

function extractVersionSection(text, version) {
  const marker = `## ${version}`
  const start = text.indexOf(marker)
  check(start >= 0, `missing changelog section ${version}`)
  const end = text.indexOf('\n## ', start + marker.length)
  return text.slice(start, end < 0 ? undefined : end)
}

async function readManifestVersions(root) {
  const versions = new Map()
  for (const path of await findFiles(root, (value) => basename(value) === 'package.json')) {
    const packageJson = JSON.parse(await readFile(join(root, path), 'utf8'))
    versions.set(path, packageJson.version)
  }
  return versions
}

async function snapshotTree(root) {
  const snapshot = new Map()
  for (const path of await findFiles(root, () => true)) {
    snapshot.set(path, await snapshotPath(join(root, path)))
  }
  return snapshot
}

async function findFiles(root, predicate) {
  const found = []
  async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue
      }
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath)
      } else if (predicate(relativePath)) {
        found.push(relativePath)
      }
    }
  }
  await visit(root)
  return found.sort()
}

async function snapshotPath(path) {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'missing'
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    return `symlink:${await readlink(path)}`
  }
  if (stat.isFile()) {
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    return `file:${String(stat.mode & 0o777)}:${hash}`
  }
  return `unsupported:${String(stat.mode)}`
}

function equalSourceStates(left, right) {
  return (
    left.head.equals(right.head) &&
    left.index.equals(right.index) &&
    left.status.equals(right.status) &&
    equalMaps(left.snapshot, right.snapshot)
  )
}

function equalMaps(left, right) {
  if (left.size !== right.size) {
    return false
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false
    }
  }
  return true
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function parseNullList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean)
}

function normalize(value) {
  return value.trim().replace(/\s+/gu, ' ')
}

function run(command, args, cwd) {
  runBytes(command, args, cwd)
}

function runText(command, args, cwd) {
  return runBytes(command, args, cwd).toString('utf8')
}

function runBytes(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) {
    throw new Error(`${basename(command)} could not start`)
  }
  if (result.status !== 0) {
    throw new Error(`${basename(command)} ${args[0] ?? ''} failed with exit ${String(result.status)}`)
  }
  return result.stdout
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function check(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
