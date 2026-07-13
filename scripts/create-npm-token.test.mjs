import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = join(repositoryRoot, 'scripts/create-npm-token.sh')
const sentinel = 'npm_R8_SENTINEL_7xQ2mV9p'
const hiddenGhOutput = 'fake-gh-secret-output'
const expectedSecretArgs = ['secret', 'set', 'NPM_TOKEN', '--repo', 'pydantic/logfire-js', '--env', 'npm']

await runCase(0)
await runCase(23)
console.log('PASS create-npm-token helper keeps the generated token on stdin and cleans up')

async function runCase(secretExitCode) {
  const caseRoot = await mkdtemp(join(tmpdir(), 'logfire-token-helper-'))
  let failure
  try {
    const fakeBin = join(caseRoot, 'bin')
    await mkdir(fakeBin)
    await writeExecutable(
      join(fakeBin, 'mktemp'),
      `#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = "-d" ] || exit 97
workdir="$CASE_ROOT/token-workdir"
mkdir -p "$workdir"
printf '%s\n' "$workdir"
`
    )
    await writeExecutable(
      join(fakeBin, 'script'),
      `#!/bin/sh
set -eu
[ "$#" -eq 5 ] && [ "$1" = "-q" ] && [ "$3" = "sh" ] && [ "$4" = "-c" ] || exit 97
printf '%s\n' '${sentinel}' > "$2"
`
    )
    await writeExecutable(
      join(fakeBin, 'npm'),
      `#!/bin/sh
set -eu
[ "$#" -eq 3 ] && [ "$1" = "whoami" ] && [ "$2" = "--registry" ] && [ "$3" = "https://registry.npmjs.org/" ] || exit 97
`
    )
    await writeExecutable(
      join(fakeBin, 'gh'),
      `#!/bin/sh
set -eu
if [ "$#" -eq 4 ] && [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--hostname" ] && [ "$4" = "github.com" ]; then
  exit 0
fi
if [ "$#" -eq 7 ] && [ "$1" = "secret" ] && [ "$2" = "set" ]; then
  : > "$CASE_ROOT/gh-argv.bin"
  for arg in "$@"; do
    printf '%s\\0' "$arg" >> "$CASE_ROOT/gh-argv.bin"
  done
  cat > "$CASE_ROOT/gh-stdin.bin"
  printf '%s\n' '${hiddenGhOutput}'
  exit "$GH_SECRET_EXIT"
fi
exit 97
`
    )

    const result = await run(helperPath, {
      ...process.env,
      CASE_ROOT: caseRoot,
      GH_SECRET_EXIT: String(secretExitCode),
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    })

    check(result.code === secretExitCode, `helper exit mismatch for fake gh exit ${String(secretExitCode)}`)
    check(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel), 'helper output exposed the generated token')
    check(
      !result.stdout.includes(hiddenGhOutput) && !result.stderr.includes(hiddenGhOutput),
      'helper exposed secret-setting command output'
    )

    const argvBytes = await readFile(join(caseRoot, 'gh-argv.bin'))
    const actualArgs = argvBytes.toString('utf8').split('\0').filter(Boolean)
    check(JSON.stringify(actualArgs) === JSON.stringify(expectedSecretArgs), 'secret-setting argv did not match the safe contract')
    check(!actualArgs.includes('--body') && !actualArgs.some((value) => value.includes(sentinel)), 'secret appeared in argv')

    const stdinBytes = await readFile(join(caseRoot, 'gh-stdin.bin'))
    check(stdinBytes.equals(Buffer.from(sentinel)), 'secret-setting stdin did not exactly match the generated token')
    check(!(await exists(join(caseRoot, 'token-workdir'))), 'helper token workdir survived process exit')
  } catch (error) {
    failure = error
  } finally {
    await rm(caseRoot, { force: true, recursive: true })
    if (await exists(caseRoot)) {
      failure ??= new Error('token test case root survived cleanup')
    }
  }
  if (failure !== undefined) {
    throw failure
  }
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, 'utf8')
  await chmod(path, 0o700)
}

async function run(path, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', [path], {
      cwd: repositoryRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`helper terminated by signal ${signal}`))
        return
      }
      resolvePromise({
        code: code ?? -1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      })
    })
  })
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
