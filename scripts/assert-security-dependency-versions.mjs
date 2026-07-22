import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArguments(args) {
  const paths = {
    lockfile: resolve(repositoryRoot, 'pnpm-lock.yaml'),
    workspace: resolve(repositoryRoot, 'pnpm-workspace.yaml'),
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument !== '--lockfile' && argument !== '--workspace') {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${argument}`)
    paths[argument.slice(2)] = resolve(value)
    index += 1
  }

  return paths
}

function versionTuple(value, label) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${label} is not a stable semantic version: ${value}`)
  return value.split('.').map(Number)
}

function compareVersions(left, right) {
  const leftParts = versionTuple(left, left)
  const rightParts = versionTuple(right, right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function declarationValue(text, pattern, label) {
  const match = text.match(pattern)
  if (!match) throw new Error(`Missing security dependency declaration: ${label}`)
  return match[1]
}

function assertExactFloor(text, pattern, label, minimum) {
  const declared = declarationValue(text, pattern, label)
  if (compareVersions(declared, minimum) < 0) {
    throw new Error(`${label} declares vulnerable version ${declared}; expected at least ${minimum}`)
  }
}

function assertCaretFloor(text, pattern, label, minimum) {
  const declared = declarationValue(text, pattern, label)
  const match = declared.match(/^\^(\d+\.\d+\.\d+)$/)
  if (!match) throw new Error(`${label} must use one caret range; found ${declared}`)
  if (compareVersions(match[1], minimum) < 0) {
    throw new Error(`${label} declares vulnerable version ${declared}; expected at least ${minimum}`)
  }
}

function assertBoundedFloor(text, pattern, label, minimum) {
  const declared = declarationValue(text, pattern, label)
  const match = declared.match(/^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/)
  if (!match) throw new Error(`${label} must use one bounded range; found ${declared}`)
  if (compareVersions(match[1], minimum) < 0) {
    throw new Error(`${label} declares vulnerable version ${declared}; expected at least ${minimum}`)
  }
}

function resolvedVersions(lockfile, packageName) {
  const packages = lockfile.match(/\npackages:\n([\s\S]*?)\nsnapshots:\n/)?.[1]
  if (!packages) throw new Error('Could not find the packages section in pnpm-lock.yaml')

  const versions = []
  for (const line of packages.split('\n')) {
    let key = line.trim()
    if (!key.endsWith(':')) continue
    key = key.slice(0, -1).replace(/^'(.*)'$/, '$1')
    const prefix = `${packageName}@`
    if (!key.startsWith(prefix)) continue
    const version = key.slice(prefix.length)
    if (/^\d+\.\d+\.\d+$/.test(version)) versions.push(version)
  }
  if (versions.length === 0) throw new Error(`No resolved ${packageName} package found in pnpm-lock.yaml`)
  return [...new Set(versions)]
}

function assertResolvedFloor(lockfile, packageName, minimum) {
  for (const version of resolvedVersions(lockfile, packageName)) {
    if (compareVersions(version, minimum) < 0) {
      throw new Error(`${packageName} resolves vulnerable version ${version}; expected at least ${minimum}`)
    }
  }
}

async function main() {
  const paths = parseArguments(process.argv.slice(2))
  const [workspace, lockfile] = await Promise.all([readFile(paths.workspace, 'utf8'), readFile(paths.lockfile, 'utf8')])

  assertExactFloor(workspace, /^  '@changesets\/parse>js-yaml': '([^']+)'$/m, '@changesets/parse>js-yaml override', '4.3.0')
  assertExactFloor(workspace, /^  'read-yaml-file@2\.1\.0>js-yaml': '([^']+)'$/m, 'read-yaml-file>js-yaml override', '4.3.0')
  assertCaretFloor(workspace, /^  'js-yaml': (\S+)$/m, 'js-yaml catalog', '4.3.0')
  assertBoundedFloor(workspace, /^  '@opentelemetry\/sdk-node': '([^']+)'$/m, '@opentelemetry/sdk-node catalog', '0.220.0')

  assertResolvedFloor(lockfile, 'js-yaml', '4.3.0')
  assertResolvedFloor(lockfile, '@opentelemetry/sdk-node', '0.220.0')
  assertResolvedFloor(lockfile, '@opentelemetry/propagator-jaeger', '2.9.0')

  const jsYamlVersions = resolvedVersions(lockfile, 'js-yaml')
  const sdkNodeVersions = resolvedVersions(lockfile, '@opentelemetry/sdk-node')
  const jaegerVersions = resolvedVersions(lockfile, '@opentelemetry/propagator-jaeger')
  if (sdkNodeVersions.some((version) => version !== '0.220.0')) {
    throw new Error(`Validation lockfile must resolve @opentelemetry/sdk-node exactly 0.220.0; found ${sdkNodeVersions.join(', ')}`)
  }

  console.log(
    `Safe dependency graph: js-yaml ${jsYamlVersions.join(', ')}; @opentelemetry/sdk-node ${sdkNodeVersions.join(', ')}; @opentelemetry/propagator-jaeger ${jaegerVersions.join(', ')}`
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
