import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserPackageName = '@pydantic/logfire-browser'
const replayPackageName = '@pydantic/logfire-session-replay'
const toolVersions = {
  '@types/node': '22.19.5',
  typescript: '6.0.3',
  'vite-plus': '0.2.1',
}

let temporaryRoot
let sourceBefore
let primaryError

try {
  const options = parseArguments(process.argv.slice(2))
  sourceBefore = options.mode === 'workspace' ? captureSourceState() : undefined
  temporaryRoot = await mkdtemp(join(tmpdir(), 'logfire-browser-release-artifacts-'))
  check(!isInside(options.evidencePath, temporaryRoot), 'evidence path must survive outside the scratch root')

  const prepared =
    options.mode === 'workspace' ? await prepareWorkspace(options, temporaryRoot) : await prepareRegistry(options, temporaryRoot)
  const artifacts = await inspectArtifacts(prepared, options, temporaryRoot)
  const consumers = await verifyNodeConsumers(artifacts, options, temporaryRoot)
  const browser = await verifyBrowserConsumers(prepared.fixtureSourceRoot, artifacts, options, temporaryRoot)

  const evidence = {
    browser,
    commands: [...prepared.commands, ...artifacts.commands, ...consumers.commands, ...browser.commands],
    generatedAt: new Date().toISOString(),
    gitRef: prepared.gitRef,
    mode: options.mode,
    packages: artifacts.packages,
    resolutions: consumers.resolutions,
    versions: {
      browser: options.browserVersion,
      replay: options.replayVersion,
    },
  }
  await mkdir(dirname(options.evidencePath), { recursive: true })
  await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(
    `PASS browser release artifacts: ${options.mode} browser ${options.browserVersion}, replay ${options.replayVersion}; evidence ${options.evidencePath}`
  )
} catch (error) {
  primaryError = error
} finally {
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { force: true, recursive: true })
      if (await exists(temporaryRoot)) {
        primaryError ??= new Error('artifact verifier scratch root survived cleanup')
      }
    } catch {
      primaryError ??= new Error('artifact verifier scratch cleanup failed')
    }
  }
  if (sourceBefore !== undefined) {
    try {
      check(equalSourceStates(sourceBefore, captureSourceState()), 'live source changed during workspace artifact verification')
    } catch (error) {
      primaryError ??= error
    }
  }
}

if (primaryError !== undefined) {
  console.error(`FAIL browser release artifacts: ${primaryError instanceof Error ? primaryError.message : 'unknown error'}`)
  process.exitCode = 1
}

function parseArguments(arguments_) {
  const mode = arguments_.shift()
  check(mode === 'workspace' || mode === 'registry', 'usage: verify-browser-release-artifacts.mjs workspace|registry [options]')
  const values = new Map()
  while (arguments_.length > 0) {
    const key = arguments_.shift()
    const value = arguments_.shift()
    check(key?.startsWith('--') === true && value !== undefined, `invalid argument ${String(key)}`)
    check(!values.has(key), `duplicate argument ${key}`)
    values.set(key, value)
  }
  const browserVersion = requiredExactVersion(values, '--browser-version')
  const replayVersion = requiredExactVersion(values, '--replay-version')
  const evidence = required(values, '--evidence')
  const evidencePath = resolve(evidence)
  check(isAbsolute(evidencePath), 'evidence path must be absolute')
  const ref = mode === 'workspace' ? required(values, '--ref') : undefined
  if (ref !== undefined) {
    check(/^[0-9a-f]{40}$/u.test(ref), 'workspace --ref must be one full 40-character commit SHA')
  }
  const allowed = new Set(['--browser-version', '--replay-version', '--evidence', ...(mode === 'workspace' ? ['--ref'] : [])])
  for (const key of values.keys()) {
    check(allowed.has(key), `unsupported argument ${key}`)
  }
  return { browserVersion, evidencePath, mode, ref, replayVersion }
}

function required(values, key) {
  const value = values.get(key)
  check(value !== undefined && value.length > 0, `missing ${key}`)
  return value
}

function requiredExactVersion(values, key) {
  const value = required(values, key)
  check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value), `${key} must be one exact semver version`)
  return value
}

async function prepareWorkspace(options, root) {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot).stdout
  check(status.length === 0, 'workspace mode requires a clean live source tree')
  run('git', ['cat-file', '-e', `${options.ref}^{commit}`], repositoryRoot)
  const scratchRepository = join(root, 'repository')
  const commands = []
  commands.push(run('git', ['clone', '--local', '--no-hardlinks', '--quiet', repositoryRoot, scratchRepository], repositoryRoot).record)
  commands.push(run('git', ['checkout', '--detach', '--quiet', options.ref], scratchRepository).record)
  const actualRef = run('git', ['rev-parse', 'HEAD'], scratchRepository)
  commands.push(actualRef.record)
  check(actualRef.stdout === options.ref, 'scratch checkout does not match requested workspace ref')
  commands.push(run(resolveExecutable('vp', repositoryRoot), ['install', '--frozen-lockfile'], scratchRepository).record)
  commands.push(run(resolveExecutable('pnpm', repositoryRoot), ['run', 'build'], scratchRepository).record)

  const tarballDirectory = join(root, 'tarballs')
  await mkdir(tarballDirectory)
  const browserPack = runPack('pnpm', browserPackageName, tarballDirectory, scratchRepository)
  const replayPack = runPack('pnpm', replayPackageName, tarballDirectory, scratchRepository)
  commands.push(browserPack.record, replayPack.record)
  return {
    commands,
    fixtureSourceRoot: scratchRepository,
    gitRef: options.ref,
    packageInputs: new Map([
      [browserPackageName, browserPack],
      [replayPackageName, replayPack],
    ]),
  }
}

async function prepareRegistry(options, root) {
  const tarballDirectory = join(root, 'tarballs')
  await mkdir(tarballDirectory)
  const browserPack = runPack('npm', `${browserPackageName}@${options.browserVersion}`, tarballDirectory, root)
  const replayPack = runPack('npm', `${replayPackageName}@${options.replayVersion}`, tarballDirectory, root)
  return {
    commands: [browserPack.record, replayPack.record],
    fixtureSourceRoot: repositoryRoot,
    gitRef: undefined,
    packageInputs: new Map([
      [browserPackageName, browserPack],
      [replayPackageName, replayPack],
    ]),
  }
}

function runPack(tool, packageSpec, destination, cwd) {
  const executable = resolveExecutable(tool, cwd)
  const arguments_ =
    tool === 'pnpm'
      ? ['--filter', packageSpec, 'pack', '--pack-destination', destination, '--json']
      : ['pack', packageSpec, '--pack-destination', destination, '--json', '--cache', join(cwd, 'npm-cache-pack')]
  const result = run(executable, arguments_, cwd)
  const payload = parseJsonOutput(result.stdout, `${tool} pack ${packageSpec}`)
  const item = Array.isArray(payload) ? payload[0] : payload
  const filename = item?.filename
  check(typeof filename === 'string' && filename.endsWith('.tgz'), `${tool} pack did not report one tarball filename`)
  return {
    filename: isAbsolute(filename) ? filename : resolve(destination, filename),
    metadata: sanitizePackMetadata(item),
    record: result.record,
  }
}

function sanitizePackMetadata(item) {
  return {
    filename: typeof item?.filename === 'string' ? item.filename.split(/[\\/]/u).at(-1) : undefined,
    integrity: typeof item?.integrity === 'string' ? item.integrity : undefined,
    name: typeof item?.name === 'string' ? item.name : undefined,
    shasum: typeof item?.shasum === 'string' ? item.shasum : undefined,
    size: typeof item?.size === 'number' ? item.size : undefined,
    version: typeof item?.version === 'string' ? item.version : undefined,
  }
}

async function inspectArtifacts(prepared, options, root) {
  const extractionRoot = join(root, 'extracted')
  await mkdir(extractionRoot)
  const commands = []
  const packages = {}
  const artifactPaths = new Map()
  for (const [name, input] of prepared.packageInputs) {
    await access(input.filename)
    const shortName = name === browserPackageName ? 'browser' : 'replay'
    const target = join(extractionRoot, shortName)
    await mkdir(target)
    const list = run('tar', ['-tzf', input.filename], root)
    commands.push(list.record)
    const entries = list.stdout.split('\n').filter(Boolean).sort()
    assertTarEntries(entries, name)
    commands.push(run('tar', ['-xzf', input.filename, '-C', target], root).record)
    const packageRoot = join(target, 'package')
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    const expectedVersion = name === browserPackageName ? options.browserVersion : options.replayVersion
    assertManifest(manifest, name, expectedVersion, options.replayVersion)
    const hashes = await hashFiles(packageRoot)
    packages[shortName] = {
      entries,
      hashes,
      manifest: {
        exports: manifest.exports,
        name: manifest.name,
        peerDependencies: manifest.peerDependencies,
        peerDependenciesMeta: manifest.peerDependenciesMeta,
        version: manifest.version,
      },
      pack: input.metadata,
      tarballSha256: await hashFile(input.filename),
    }
    artifactPaths.set(name, input.filename)
  }
  return { artifactPaths, commands, packages }
}

function assertTarEntries(entries, name) {
  const required = [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.cjs',
    'package/dist/index.d.cts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/package.json',
  ]
  for (const entry of required) {
    check(entries.includes(entry), `${name} tarball is missing ${entry}`)
  }
  const forbidden = entries.filter(
    (entry) =>
      /(^|\/)(?:src|test|tests|test-fixtures|fixtures)(?:\/|$)/u.test(entry) ||
      /(^|\/)(?:\.env|\.npmrc)(?:\.|$)/u.test(entry) ||
      /(?:credential|secret)/iu.test(entry)
  )
  check(forbidden.length === 0, `${name} tarball contains forbidden entries: ${forbidden.join(', ')}`)
}

function assertManifest(manifest, name, expectedVersion, replayVersion) {
  check(manifest.name === name, `${name} packed manifest has the wrong name`)
  check(manifest.version === expectedVersion, `${name} packed manifest has version ${String(manifest.version)}`)
  check(manifest.main === './dist/index.cjs', `${name} packed manifest has the wrong CJS entry`)
  check(manifest.module === './dist/index.js', `${name} packed manifest has the wrong ESM entry`)
  check(manifest.types === './dist/index.d.ts', `${name} packed manifest has the wrong declaration entry`)
  check(manifest.exports?.['.']?.import?.default === './dist/index.js', `${name} import export is incorrect`)
  check(manifest.exports?.['.']?.import?.types === './dist/index.d.ts', `${name} import types export is incorrect`)
  check(manifest.exports?.['.']?.require?.default === './dist/index.cjs', `${name} require export is incorrect`)
  check(manifest.exports?.['.']?.require?.types === './dist/index.d.cts', `${name} require types export is incorrect`)
  if (name === browserPackageName) {
    const replayPeer = manifest.peerDependencies?.[replayPackageName]
    const acceptedReplayPeers = expectedVersion.includes('-')
      ? new Set([replayVersion, `^${replayVersion}`])
      : new Set([`^${replayVersion}`])
    check(
      acceptedReplayPeers.has(replayPeer),
      `browser optional replay peer is ${String(replayPeer)}, expected ${[...acceptedReplayPeers].join(' or ')}`
    )
    check(manifest.peerDependenciesMeta?.[replayPackageName]?.optional === true, 'browser replay peer is not optional')
  }
}

async function verifyNodeConsumers(artifacts, options, root) {
  const commands = []
  const resolutions = []
  const withReplay = join(root, 'consumer-with-replay')
  await createConsumer(withReplay, dependencySpecs(artifacts, options, true), true)
  commands.push(run('npm', ['install', '--ignore-scripts', '--cache', join(root, 'npm-cache')], withReplay).record)
  await writeNodeSmokeFiles(withReplay, true)
  const esm = await runNodeSmoke('smoke.mjs', withReplay)
  const cjs = await runNodeSmoke('smoke.cjs', withReplay)
  commands.push(esm.record, cjs.record)
  resolutions.push(...JSON.parse(esm.stdout).resolutions, ...JSON.parse(cjs.stdout).resolutions)
  commands.push(run(join(withReplay, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], withReplay).record)

  const withoutReplay = join(root, 'consumer-without-replay')
  await createConsumer(withoutReplay, dependencySpecs(artifacts, options, false), false)
  commands.push(
    run('npm', ['install', '--ignore-scripts', '--omit=optional', '--cache', join(root, 'npm-cache-without-replay')], withoutReplay).record
  )
  await writeNodeSmokeFiles(withoutReplay, false)
  const absent = await runNodeSmoke('smoke.mjs', withoutReplay)
  commands.push(absent.record)
  resolutions.push(...JSON.parse(absent.stdout).resolutions)

  for (const resolution of resolutions) {
    const consumerRoot = resolution.consumer === 'with-replay' ? withReplay : withoutReplay
    const consumerNodeModules = await realpath(join(consumerRoot, 'node_modules'))
    check(
      isInside(fileURLToPathIfNeeded(resolution.path), consumerNodeModules),
      `package resolved outside consumer node_modules: ${resolution.path}`
    )
  }
  await assertGeneratedSources(withReplay)
  await assertGeneratedSources(withoutReplay)
  return { commands, resolutions }
}

function dependencySpecs(artifacts, options, includeReplay) {
  const dependencies = {
    [browserPackageName]:
      options.mode === 'workspace' ? pathToFileURL(artifacts.artifactPaths.get(browserPackageName)).href : options.browserVersion,
  }
  if (includeReplay) {
    dependencies[replayPackageName] =
      options.mode === 'workspace' ? pathToFileURL(artifacts.artifactPaths.get(replayPackageName)).href : options.replayVersion
  }
  return dependencies
}

async function createConsumer(directory, dependencies, includeTooling) {
  await mkdir(directory, { recursive: true })
  const manifest = {
    name: `logfire-release-consumer-${includeTooling ? 'with' : 'without'}-replay`,
    private: true,
    type: 'module',
    dependencies,
    ...(includeTooling ? { devDependencies: toolVersions } : {}),
  }
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function writeNodeSmokeFiles(directory, includeReplay) {
  const rootLiteral = JSON.stringify(directory)
  const replayAssertions = includeReplay
    ? `
const replay = await import(${JSON.stringify(replayPackageName)})
assert.equal(typeof replay.startSessionReplay, 'function')
resolutions.push({ consumer: 'with-replay', path: import.meta.resolve(${JSON.stringify(replayPackageName)}) })`
    : `
let replayMissing = false
try { import.meta.resolve(${JSON.stringify(replayPackageName)}) } catch { replayMissing = true }
assert.equal(replayMissing, true)`
  await writeFile(
    join(directory, 'smoke.mjs'),
    `import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
const browser = await import(${JSON.stringify(browserPackageName)})
assert.equal(typeof browser.configure, 'function')
assert.equal(typeof browser.getBrowserSessionId, 'function')
const resolutions = [{ consumer: ${JSON.stringify(includeReplay ? 'with-replay' : 'without-replay')}, path: import.meta.resolve(${JSON.stringify(browserPackageName)}) }]
${replayAssertions}
for (const item of resolutions) item.path = await realpath(new URL(item.path))
console.log(JSON.stringify({ consumerRoot: ${rootLiteral}, resolutions }))
`
  )
  if (!includeReplay) {
    return
  }
  await writeFile(
    join(directory, 'smoke.cjs'),
    `const assert = require('node:assert/strict')
const fs = require('node:fs')
const browser = require(${JSON.stringify(browserPackageName)})
const replay = require(${JSON.stringify(replayPackageName)})
assert.equal(typeof browser.configure, 'function')
assert.equal(typeof replay.startSessionReplay, 'function')
console.log(JSON.stringify({ resolutions: [
  { consumer: 'with-replay', path: fs.realpathSync(require.resolve(${JSON.stringify(browserPackageName)})) },
  { consumer: 'with-replay', path: fs.realpathSync(require.resolve(${JSON.stringify(replayPackageName)})) }
] }))
`
  )
  await writeFile(
    join(directory, 'types.ts'),
    `import { configure, type BrowserConfigureHandle, type BrowserSessionReplayHandle } from ${JSON.stringify(browserPackageName)}
import { startSessionReplay } from ${JSON.stringify(replayPackageName)}
declare const handle: BrowserConfigureHandle
const replay: BrowserSessionReplayHandle | undefined = handle.sessionReplay
const cleanup: () => Promise<void> = configure({ traceUrl: '/traces' })
void cleanup
void replay
void startSessionReplay
`
  )
  await writeFile(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['DOM', 'ES2024'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2024',
        },
        include: ['types.ts'],
      },
      null,
      2
    )}\n`
  )
}

async function verifyBrowserConsumers(fixtureSourceRoot, artifacts, options, root) {
  const consumerRoot = join(root, 'browser-consumer')
  await createConsumer(consumerRoot, dependencySpecs(artifacts, options, true), true)
  const commands = [run('npm', ['install', '--ignore-scripts', '--cache', join(root, 'npm-cache-browser')], consumerRoot).record]
  const fixtureRoot = join(consumerRoot, 'fixtures')
  await mkdir(fixtureRoot)
  for (const fixture of ['self-observation', 'privacy-defaults', 'optional-feature-api']) {
    await copyFixture(fixtureSourceRoot, fixtureRoot, fixture)
  }
  await assertGeneratedSources(consumerRoot)

  const vp = join(consumerRoot, 'node_modules/.bin/vp')
  const receipts = {}
  receipts.selfObservation = await runFixture({
    commands,
    config: join(fixtureRoot, 'self-observation/vite.config.ts'),
    cwd: consumerRoot,
    openUrl: 'http://127.0.0.1:4175/nested/page/',
    port: 4175,
    session: sessionName('self', options),
    verify: [process.execPath, [join(fixtureRoot, 'self-observation/verify.mjs')]],
    vp,
    waitExpression: "['observing', 'failed'].includes(window.__logfireSelfObservation?.phase)",
    cleanupExpression: '(async () => { await window.__logfireSelfObservation.cleanup() })()',
  })
  const privacy = await runPrivacyFixtures({
    commands,
    config: join(fixtureRoot, 'privacy-defaults/vite.config.ts'),
    cwd: consumerRoot,
    options,
    verifyPath: join(fixtureRoot, 'privacy-defaults/verify.mjs'),
    vp,
  })
  receipts.privacyDefault = privacy.default
  receipts.privacyOptIn = privacy.optIn
  commands.push(
    run(join(consumerRoot, 'node_modules/.bin/tsc'), ['--project', join(fixtureRoot, 'optional-feature-api/tsconfig.json')], consumerRoot)
      .record
  )
  receipts.optionalFeatureApi = await runFixture({
    commands,
    config: join(fixtureRoot, 'optional-feature-api/vite.config.ts'),
    cwd: consumerRoot,
    openUrl: 'http://127.0.0.1:4179/',
    port: 4179,
    session: sessionName('optional', options),
    verify: [process.execPath, [join(fixtureRoot, 'optional-feature-api/verify.mjs')]],
    vp,
    waitExpression: "['complete', 'failed'].includes(window.__logfireOptionalFeatureApi?.phase)",
  })
  return { commands, receipts }
}

function sessionName(kind, options) {
  return `r9-${kind}-${options.mode}-${process.pid}`
}

async function copyFixture(sourceRoot, destinationRoot, name) {
  const source = join(sourceRoot, 'packages/logfire-browser/test-fixtures', name)
  const destination = join(destinationRoot, name)
  await cp(source, destination, { recursive: true })
  await rm(join(destination, 'recorder.d.ts'), { force: true })
  const mainPath = join(destination, 'main.ts')
  let main = await readFile(mainPath, 'utf8')
  main = main
    .replaceAll("'../../dist/index.js'", JSON.stringify(browserPackageName))
    .replaceAll("'lf-self-observation-recorder'", JSON.stringify(replayPackageName))
    .replaceAll("'lf-privacy-recorder'", JSON.stringify(replayPackageName))
  await writeFile(mainPath, main)
  if (name === 'self-observation' || name === 'privacy-defaults') {
    const configPath = join(destination, 'vite.config.ts')
    let config = await readFile(configPath, 'utf8')
    const constantsStart = config.indexOf('const packageDirectory =')
    const receiptsStart = config.indexOf('const receipts:')
    check(constantsStart !== -1 && receiptsStart > constantsStart, `${name} fixture config prelude changed`)
    config = `${config.slice(0, constantsStart)}${config.slice(receiptsStart)}`
    const runtimePluginStart = config.indexOf(
      `    {\n      name: 'logfire-${name === 'self-observation' ? 'self-observation' : 'privacy'}-recorder-runtime'`
    )
    const receiptPluginStart = config.indexOf(
      `    {\n      name: 'logfire-${name === 'self-observation' ? 'self-observation' : 'privacy'}-receipts'`
    )
    check(runtimePluginStart !== -1 && receiptPluginStart > runtimePluginStart, `${name} fixture recorder plugin changed`)
    config = `${config.slice(0, runtimePluginStart)}${config.slice(receiptPluginStart)}`
    await writeFile(configPath, config)
  }
  if (name === 'optional-feature-api') {
    const widenedMain = (await readFile(mainPath, 'utf8')).replace('attempts = 100', 'attempts = 2_000').replace(
      "  state.phase = 'failed'\n  const status",
      `  state.phase = 'failed'
  void fetch('/receipts/state', {
    body: JSON.stringify(state),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const status`
    )
    await writeFile(mainPath, widenedMain)
    const configPath = join(destination, 'vite.config.ts')
    const config = (await readFile(configPath, 'utf8')).replace(
      '  root: fixtureDirectory,',
      `  optimizeDeps: { exclude: [${JSON.stringify(browserPackageName)}] },\n  root: fixtureDirectory,`
    )
    await writeFile(configPath, config)
    const verifyPath = join(destination, 'verify.mjs')
    const verify = (await readFile(verifyPath, 'utf8')).replace(
      'new URL(`../../dist/${declaration}`, import.meta.url)',
      `new URL(\`../../node_modules/@pydantic/logfire-browser/dist/\${declaration}\`, import.meta.url)`
    )
    await writeFile(verifyPath, verify)
  }
}

async function runFixture({ cleanupExpression, commands, config, cwd, openUrl, port, session, verify, vp, waitExpression }) {
  const server = startFixtureServer(vp, config, port, cwd)
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  server.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  try {
    await waitForServer(`http://127.0.0.1:${String(port)}/`, server, () => output)
    commands.push(run('agent-browser', ['--session', session, 'open', openUrl], cwd).record)
    commands.push(run('agent-browser', ['--session', session, 'wait', '--fn', waitExpression], cwd).record)
    const verified = run(verify[0], verify[1], cwd)
    commands.push(verified.record)
    if (cleanupExpression !== undefined) {
      commands.push(run('agent-browser', ['--session', session, 'eval', cleanupExpression], cwd).record)
    }
    return parseJsonOutput(verified.stdout, `${session} verifier`)
  } finally {
    runAllowFailure('agent-browser', ['--session', session, 'close'], cwd)
    await stopProcessTree(server)
  }
}

async function runPrivacyFixtures({ commands, config, cwd, options, verifyPath, vp }) {
  const port = 4178
  const server = startFixtureServer(vp, config, port, cwd)
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  server.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  try {
    await waitForServer(`http://127.0.0.1:${String(port)}/`, server, () => output)
    const defaultReceipt = runBrowserScenario({
      commands,
      cwd,
      openUrl: 'http://127.0.0.1:4178/default/?page_secret=default-page-secret#default-fragment-secret',
      session: sessionName('privacy-default', options),
      verify: [process.execPath, [verifyPath, 'default']],
      waitExpression: "['complete', 'failed'].includes(window.__logfirePrivacyDefaults?.phase)",
    })
    await new Promise((resolve_) => setTimeout(resolve_, 1_000))
    const optInReceipt = runBrowserScenario({
      commands,
      cwd,
      openUrl: 'http://127.0.0.1:4178/opt-in/?page_secret=opt-in-page-secret#opt-in-fragment-secret',
      session: sessionName('privacy-opt-in', options),
      verify: [process.execPath, [verifyPath, 'opt-in']],
      waitExpression: "['complete', 'failed'].includes(window.__logfirePrivacyDefaults?.phase)",
    })
    return { default: defaultReceipt, optIn: optInReceipt }
  } finally {
    await stopProcessTree(server)
  }
}

function runBrowserScenario({ cleanupExpression, commands, cwd, openUrl, session, verify, waitExpression }) {
  try {
    commands.push(run('agent-browser', ['--session', session, 'open', openUrl], cwd).record)
    commands.push(run('agent-browser', ['--session', session, 'wait', '--fn', waitExpression], cwd).record)
    const verified = run(verify[0], verify[1], cwd)
    commands.push(verified.record)
    if (cleanupExpression !== undefined) {
      commands.push(run('agent-browser', ['--session', session, 'eval', cleanupExpression], cwd).record)
    }
    return parseJsonOutput(verified.stdout, `${session} verifier`)
  } finally {
    commands.push(run('agent-browser', ['--session', session, 'close'], cwd).record)
  }
}

function startFixtureServer(vp, config, port, cwd) {
  return spawn(vp, ['dev', '--config', config, '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForServer(url, process_, output) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (process_.exitCode !== null) {
      throw new Error(`Vite fixture exited before readiness: ${output().slice(-2_000)}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // The loopback server is still starting.
    }
    await new Promise((resolve_) => setTimeout(resolve_, 100))
  }
  throw new Error(`timed out waiting for ${url}: ${output().slice(-2_000)}`)
}

async function stopProcessTree(process_) {
  if (process_.exitCode !== null) {
    return
  }
  signalProcessTree(process_, 'SIGTERM')
  await Promise.race([new Promise((resolve_) => process_.once('exit', resolve_)), new Promise((resolve_) => setTimeout(resolve_, 5_000))])
  if (process_.exitCode === null) {
    signalProcessTree(process_, 'SIGKILL')
  }
}

function signalProcessTree(process_, signal) {
  if (process_.pid === undefined) {
    return
  }
  try {
    if (process.platform !== 'win32') {
      process.kill(-process_.pid, signal)
    } else {
      process_.kill(signal)
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }
}

async function assertGeneratedSources(root) {
  const forbidden = ['workspace:', '../../dist', '/packages/', repositoryRoot]
  const files = await walkFiles(root, (path) => !path.includes(`${sep}node_modules${sep}`) && !path.endsWith('package-lock.json'))
  for (const path of files) {
    if (!/\.(?:c?js|mjs|ts|json|html)$/u.test(path)) {
      continue
    }
    const source = await readFile(path, 'utf8')
    for (const marker of forbidden) {
      check(!source.includes(marker), `generated consumer source ${relative(root, path)} contains forbidden marker ${marker}`)
    }
  }
  const lockPath = join(root, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = await readFile(lockPath, 'utf8')
    check(!lock.includes('workspace:'), 'generated package lock contains a workspace protocol')
    check(!lock.includes(repositoryRoot), 'generated package lock contains the live repository path')
  }
}

async function walkFiles(root, include) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (!include(path)) {
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path, include)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

async function hashFiles(root) {
  const hashes = {}
  for (const path of await walkFiles(root, () => true)) {
    hashes[relative(root, path).split(sep).join('/')] = await hashFile(path)
  }
  return hashes
}

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function captureSourceState() {
  return {
    head: runBytes('git', ['rev-parse', 'HEAD'], repositoryRoot).toString('hex'),
    index: runBytes('git', ['ls-files', '--stage', '-z'], repositoryRoot).toString('hex'),
    status: runBytes('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryRoot).toString('hex'),
  }
}

function equalSourceStates(left, right) {
  return left.head === right.head && left.index === right.index && left.status === right.status
}

function run(executable, arguments_, cwd, options = {}) {
  const timeout = basenameForError(executable) === 'agent-browser' ? 60_000 : 10 * 60_000
  const result = spawnSync(executable, arguments_, {
    cwd,
    encoding: 'utf8',
    env: options.env ?? { ...process.env, CI: 'true' },
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${basenameForError(executable)} ${arguments_.join(' ')} failed (${String(result.status)}): ${(result.stderr || result.stdout || result.error?.message || '').slice(-4_000)}`
    )
  }
  return {
    record: {
      args: arguments_,
      command: basenameForError(executable),
      cwd: relative(repositoryRoot, cwd) || '.',
      status: result.status,
    },
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  }
}

async function runNodeSmoke(filename, cwd) {
  const canonicalRoot = await realpath(cwd)
  return run(
    process.execPath,
    ['--permission', `--allow-fs-read=${canonicalRoot}`, `--allow-fs-write=${canonicalRoot}`, filename],
    canonicalRoot,
    {
      env: { CI: 'true' },
    }
  )
}

function runAllowFailure(executable, arguments_, cwd) {
  return spawnSync(executable, arguments_, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
}

function runBytes(executable, arguments_, cwd) {
  const result = spawnSync(executable, arguments_, { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(' ')} failed`)
  }
  return result.stdout
}

function resolveExecutable(name, cwd) {
  const local = join(cwd, 'node_modules/.bin', name)
  return existsSync(local) ? local : name
}

function parseJsonOutput(output, label) {
  const candidates = [output, ...output.split('\n').reverse()]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next bounded candidate.
    }
  }
  throw new Error(`${label} did not emit parseable JSON: ${output.slice(-2_000)}`)
}

function fileURLToPathIfNeeded(value) {
  return value.startsWith('file:') ? fileURLToPath(value) : value
}

function isInside(path, root) {
  const pathRelative = relative(resolve(root), resolve(path))
  return pathRelative === '' || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== '..' && !isAbsolute(pathRelative))
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

function basenameForError(path) {
  return path.split(/[\\/]/u).at(-1) ?? path
}
