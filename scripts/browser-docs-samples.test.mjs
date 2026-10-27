import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const root = resolve(import.meta.dirname, '..')
const pages = [
  'browser.md',
  'browser/errors.md',
  'browser/identity.md',
  'browser/performance.md',
  'browser/replay.md',
  'browser/advanced.md',
  '../../packages/logfire-browser/.agents/skills/logfire-frontend/references/setup.md',
  '../../packages/logfire-browser/.agents/skills/logfire-frontend/references/capture-profiles.md',
]

function samples(page) {
  const markdown = readFileSync(resolve(root, 'docs/packages', page), 'utf8')
  return [...markdown.matchAll(/^```(tsx|ts)\b[^\n]*\n([\s\S]*?)^```/gm)].map((match) => ({ language: match[1], code: match[2] }))
}

test('browser guide SDK snippets typecheck against the built public API', () => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'logfire-browser-doc-samples-'))
  let checked = 0
  try {
    for (const page of pages) {
      for (const { language, code } of samples(page)) {
        // Component recipes need their framework's compiler, and handwritten route
        // recipes need application routes. Route helpers run below.
        if (language === 'tsx' || /router\.state|router\.history|export function (?:setRouteName|getRouteName)/u.test(code)) continue
        const filename = resolve(scratch, `${page.replace(/[/.]/g, '-')}-sample-${checked}.ts`)
        const context = `
        ${code.includes('import * as logfire') ? '' : "import * as logfire from '@pydantic/logfire-browser'"}
        ${code.includes('import { sessionReplayIntegration }') ? '' : "import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'"}
        ${code.includes('const frontendOptions =') ? '' : 'declare const frontendOptions: { baseUrl: string; token: string }'}
        ${code.includes('const router =') ? '' : 'declare const router: import("vue-router").Router'}
        ${code.includes("from '@tanstack/react-router'") ? 'declare const routeTree: import("@tanstack/react-router").AnyRoute' : ''}
        ${code.includes("from 'react-router'") ? 'declare const routes: import("react-router").RouteObject[]' : ''}
        ${code.includes("from 'vue-router'") ? 'declare const routes: import("vue-router").RouteRecordRaw[]' : ''}
        declare const currentAccount: { tier: string }
        declare const currentUser: { id: string; name: string; email: string; isBeta: boolean } | undefined
        declare const customProcessor: NonNullable<Parameters<typeof logfire.configureFrontend>[0]['spanProcessors']>[number]
        declare function saveOrder(): Promise<void>
        declare function loadDashboard(): Promise<void>
        declare function getCsrfToken(): string
        ${/const cleanup\s*=/u.test(code) ? '' : 'declare const cleanup: ReturnType<typeof logfire.configureFrontend>'}
      `
        writeFileSync(filename, context + '\n' + code)
        checked++
      }
    }
    const config = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        target: 'ES2024',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {
          '@opentelemetry/api': [resolve(root, 'packages/logfire-browser/node_modules/@opentelemetry/api')],
          '@pydantic/logfire-browser': [resolve(root, 'packages/logfire-browser/dist/index.d.ts')],
          '@pydantic/logfire-browser/react-router': [resolve(root, 'packages/logfire-browser/dist/react-router.d.ts')],
          '@pydantic/logfire-browser/tanstack-router': [resolve(root, 'packages/logfire-browser/dist/tanstack-router.d.ts')],
          '@pydantic/logfire-browser/vue-router': [resolve(root, 'packages/logfire-browser/dist/vue-router.d.ts')],
          '@tanstack/react-router': [resolve(root, 'packages/logfire-browser/node_modules/@tanstack/react-router')],
          'react-router': [resolve(root, 'packages/logfire-browser/node_modules/react-router/dist/production/index.d.ts')],
          'vue-router': [resolve(root, 'packages/logfire-browser/node_modules/vue-router')],
          '@pydantic/logfire-session-replay/integration': [resolve(root, 'packages/logfire-session-replay/dist/integration.d.ts')],
        },
      },
      include: ['*.ts'],
    }
    writeFileSync(resolve(scratch, 'tsconfig.json'), JSON.stringify(config))
    try {
      execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--project', resolve(scratch, 'tsconfig.json')], {
        encoding: 'utf8',
      })
    } catch (error) {
      assert.fail(error.stdout || error.message)
    }
    assert.equal(checked, 33, 'Account for added or removed SDK samples explicitly')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

function routeHelper(code) {
  const start = code.indexOf(code.includes('function decodeSegment') ? 'function decodeSegment' : 'function routeTemplate')
  const end = code.indexOf(code.includes('function RouteName') ? 'function RouteName' : 'const router =')
  assert.ok(start >= 0 && end > start, 'Route helper boundaries changed')
  const source = code.slice(start, end)
  assert.ok(source.includes('function routeTemplate'), 'Missing documented route helper')
  const outputText = stripTypeScriptTypes(source)
  return runInNewContext(outputText + '\nrouteTemplate')
}

test('Next.js route recipe handles dynamic, encoded and catch-all segments with its documented limits', () => {
  const code = samples('browser/identity.md').find(({ code }) => code.includes('decodeSegment'))?.code
  assert.ok(code)
  const template = routeHelper(code)
  for (const [pathname, params, expected] of [
    ['/', {}, '/'],
    ['/acme/shop/agents', { org: 'acme', project: 'shop' }, '/[org]/[project]/agents'],
    ['/globex/web/agents', { org: 'globex', project: 'web' }, '/[org]/[project]/agents'],
    ['/blog/hello%20world', { slug: 'hello world' }, '/blog/[slug]'],
    ['/blog/%invalid', { slug: '%invalid' }, '/blog/[slug]'],
    ['/shop/a/b', { slug: ['a', 'b'] }, '/shop/[...slug]'],
    ['/shop', {}, '/shop'],
    ['/unknown', {}, '/unknown'],
    ['/a/a', { id: 'a' }, '/a/[id]'],
  ]) {
    assert.equal(template(pathname, params), expected)
  }
})

test('custom-domain Worker example preserves ingest bytes and status while rejecting unrelated routes', async () => {
  const page = readFileSync(resolve(root, 'docs/frontend-custom-domain.md'), 'utf8')
  const code = /^```js\n([\s\S]*?)^```/m.exec(page)?.[1]
  assert.ok(code, 'Missing documented Worker')
  const requests = []
  const worker = runInNewContext(code.replace('export default', 'const worker =') + '\nworker', {
    URL,
    Request,
    Response,
    Headers,
    fetch: async (request) => {
      requests.push(request)
      return new Response('{}', { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } })
    },
  })
  for (const path of ['/v1/traces', '/v1/metrics', '/v1/replay/recording-id?seq=7']) {
    const bytes = new Uint8Array([31, 139, 0, 255, 42])
    const response = await worker.fetch(
      new Request(`https://e.example.com${path}`, {
        method: 'POST',
        body: bytes,
        headers: {
          Authorization: 'Bearer public-token',
          Cookie: 'private=session',
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
      })
    )
    assert.equal(response.status, 202)
    const forwarded = requests.at(-1)
    assert.equal(forwarded.url, `https://logfire-us.pydantic.dev${path}`)
    assert.equal(forwarded.headers.get('cookie'), null)
    assert.equal(forwarded.headers.get('authorization'), 'Bearer public-token')
    assert.equal(forwarded.headers.get('content-encoding'), 'gzip')
    assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), bytes)
  }
  const preflight = await worker.fetch(
    new Request('https://e.example.com/v1/traces', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' },
    })
  )
  assert.equal(preflight.status, 202)
  assert.equal(requests.at(-1).method, 'OPTIONS')
  assert.equal(requests.at(-1).headers.get('origin'), 'https://app.example.com')
  for (const [path, method, status] of [
    ['/v1/traces', 'GET', 405],
    ['/v1/traces?target=https://evil.example', 'POST', 404],
    ['/v1/replay/id?seq=1&seq=2', 'POST', 404],
    ['/v1/replay/id?seq=-1', 'POST', 404],
    ['/v1/replay/id/extra?seq=1', 'POST', 404],
    ['/api/projects', 'POST', 404],
  ]) {
    assert.equal((await worker.fetch(new Request(`https://e.example.com${path}`, { method }))).status, status)
  }
  assert.equal(requests.length, 4, 'Rejected requests must not reach the upstream')
})
