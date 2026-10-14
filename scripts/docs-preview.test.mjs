import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/docs-preview.yml', import.meta.url), 'utf8')

// Execute the actual inline Bash, not a second implementation of dispatch.
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, `Missing workflow step: ${name}`)
  const next = workflow.indexOf('\n      - name:', start + 1)
  return workflow.slice(start, next < 0 ? undefined : next)
}

function run(name) {
  const script = step(name).split('        run: |\n')[1]
  assert.ok(script, `Missing Bash script: ${name}`)
  return script.replace(/^ {10}/gm, '')
}

function execute(script, env) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REPO: 'pydantic/logfire-js', ...env },
  })
}

test('the privileged workflow is label-only and never loads PR code', () => {
  assert.match(workflow, /pull_request_target:\n    types: \[labeled\]/)
  assert.match(workflow, /if: github.event.label.name == 'trigger:docs'/)
  assert.match(workflow, /permissions: \{\}/)
  assert.match(workflow, /timeout-minutes: 5/)
  assert.doesNotMatch(workflow, /actions\/checkout|\bgit\b|\b(npm|pnpm|node|curl|wget)\b/)
  assert.ok(workflow.indexOf('name: Verify maintainer permission') < workflow.indexOf('uses: actions/create-github-app-token'))
  assert.match(step('Generate docs app dispatch token'), /repositories: unified-docs/)
  assert.match(step('Generate docs app dispatch token'), /permission-contents: write/)
  assert.doesNotMatch(step('Generate docs app dispatch token'), /permission-(issues|pull-requests)/)
  assert.match(step('Generate docs app dispatch token'), /create-github-app-token@[a-f0-9]{40}/)
  // Untrusted expressions travel via env, never through shell program text.
  for (const name of ['Verify maintainer permission', 'Dispatch exact PR head', 'Report dispatch failure']) {
    assert.doesNotMatch(run(name), /\$\{\{/)
  }
})

for (const permission of ['admin', 'maintain', 'write', 'read', 'triage', 'none', '']) {
  test(`maintainer permission check: ${permission || 'empty'}`, () => {
    const result = execute(
      `
      gh() {
        printf '%s\\n' "$*" >&2
        printf '%s\\n' "$TEST_PERMISSION"
      }
      ${run('Verify maintainer permission')}
    `,
      { ACTOR: 'reviewer', TEST_PERMISSION: permission }
    )
    assert.match(result.stderr, /repos\/pydantic\/logfire-js\/collaborators\/reviewer\/permission --jq .permission/)
    assert.equal(result.status, ['admin', 'maintain', 'write'].includes(permission) ? 0 : 1)
  })
}

test('permission lookup fails closed', () => {
  const result = execute(`gh() { return 1; }; ${run('Verify maintainer permission')}`, { ACTOR: 'reviewer' })
  assert.equal(result.status, 1)
})

test('dispatch preserves the source repository, PR and exact head SHA as data', () => {
  const sha = 'a'.repeat(40)
  const result = execute(`gh() { printf '%s\\0' "$@"; }; ${run('Dispatch exact PR head')}`, {
    PR_NUMBER: '377',
    HEAD_SHA: sha,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), [
    'api',
    'repos/pydantic/unified-docs/dispatches',
    '--method',
    'POST',
    '-f',
    'event_type=docs-preview',
    '-f',
    'client_payload[library]=logfire-js',
    '-f',
    'client_payload[source_repo]=pydantic/logfire-js',
    '-f',
    'client_payload[source_pr]=377',
    '-f',
    `client_payload[source_sha]=${sha}`,
  ])
})

test('a failed receiver request fails dispatch rather than implying a queued preview', () => {
  const result = execute(`gh() { return 1; }; ${run('Dispatch exact PR head')}`, {
    PR_NUMBER: '377',
    HEAD_SHA: 'a'.repeat(40),
  })
  assert.equal(result.status, 1)
  assert.match(step('Report dispatch failure'), /if: failure\(\) && steps.maintainer.outcome == 'success'/)
  assert.match(step('Remove trigger label'), /if: always\(\) && steps.maintainer.outcome == 'success'/)
})

test('dispatcher regression tests are part of local and hosted CI', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const ci = readFileSync(new URL('../.github/workflows/main.yml', import.meta.url), 'utf8')
  assert.match(pkg.scripts.check, /pnpm run test:docs-preview/)
  assert.equal(pkg.scripts['test:docs-preview'], 'node --test scripts/docs-preview.test.mjs')
  assert.match(ci, /run: pnpm run test:docs-preview/)
})
