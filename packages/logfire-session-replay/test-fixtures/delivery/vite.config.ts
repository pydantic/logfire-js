import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

interface ReplayReceipt {
  authorization?: string
  body: string
  byteLength: number
  marker?: string
  receivedAt: number
  seq: number
  url: string
}

interface ApplicationReceipt {
  byteLength: number
  path: string
}

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(fixtureDirectory, '../..')
const recorderEntrypoint = resolve(packageDirectory, 'dist/index.js')
const require = createRequire(recorderEntrypoint)
const rrwebEntrypoint = require.resolve('rrweb').replace(/dist\/rrweb\.cjs$/u, 'dist/rrweb.js')
const fflateEntrypoint = resolve(dirname(require.resolve('fflate/package.json')), 'esm/browser.js')
const moduleId = 'lf-replay-delivery'
const resolvedModuleId = `\0${moduleId}`
const receipts = new Map<string, ReplayReceipt[]>()
const applicationReceipts = new Map<string, ApplicationReceipt[]>()
const states = new Map<string, unknown>()
const heldResponses: ServerResponse[] = []
let unloadReleasedAt: number | undefined

function loadRecorderModule(): string {
  return readFileSync(recorderEntrypoint, 'utf8')
    .replaceAll('from"rrweb"', `from${JSON.stringify(rrwebEntrypoint)}`)
    .replaceAll('from"fflate"', `from${JSON.stringify(fflateEntrypoint)}`)
}

export default defineConfig({
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-replay-delivery-runtime',
      resolveId(id) {
        return id === moduleId ? resolvedModuleId : undefined
      },
      load(id) {
        return id === resolvedModuleId ? loadRecorderModule() : undefined
      },
    },
    {
      name: 'logfire-replay-delivery-receipts',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (request.method === 'GET' && url.pathname === '/csp/') {
            response.setHeader(
              'content-security-policy',
              "default-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'none'; style-src 'self'"
            )
            next()
            return
          }
          const scenario = url.searchParams.get('scenario') ?? scenarioFromReplayPath(url.pathname)
          if (request.method === 'POST' && url.pathname === '/fixture/reset') {
            receipts.set(scenario, [])
            applicationReceipts.set(scenario, [])
            states.delete(scenario)
            if (scenario === 'unload') {
              unloadReleasedAt = undefined
            }
            response.statusCode = 204
            response.end()
            return
          }
          if (request.method === 'POST' && url.pathname === '/fixture/state') {
            readBody(request, (body) => {
              states.set(scenario, JSON.parse(body.toString('utf8')))
              response.statusCode = 204
              response.end()
            })
            return
          }
          if (request.method === 'GET' && url.pathname === '/fixture/status') {
            response.setHeader('content-type', 'application/json')
            response.end(
              JSON.stringify({
                applicationReceipts: applicationReceipts.get(scenario) ?? [],
                receipts: receipts.get(scenario) ?? [],
                state: states.get(scenario),
                unloadReleasedAt,
              })
            )
            return
          }
          if (request.method === 'POST' && url.pathname === '/fixture/release') {
            unloadReleasedAt = Date.now()
            for (const held of heldResponses.splice(0)) {
              held.statusCode = 202
              held.end()
            }
            response.statusCode = 204
            response.end()
            return
          }
          if (request.method === 'POST' && url.pathname.startsWith('/application/')) {
            readBody(request, (body) => {
              const values = applicationReceipts.get(scenario) ?? []
              values.push({ byteLength: body.byteLength, path: url.pathname })
              applicationReceipts.set(scenario, values)
              response.statusCode = 204
              response.end()
            })
            return
          }
          if (request.method !== 'POST' || scenario === 'unknown' || !url.pathname.startsWith('/replay/')) {
            next()
            return
          }
          readBody(request, (body) => {
            const scenarioReceipts = receipts.get(scenario) ?? []
            scenarioReceipts.push({
              authorization: headerValue(request.headers.authorization),
              body: body.toString('base64'),
              byteLength: body.byteLength,
              marker: headerValue(request.headers['x-replay-marker']),
              receivedAt: Date.now(),
              seq: Number(url.searchParams.get('seq')),
              url: request.url ?? '/',
            })
            receipts.set(scenario, scenarioReceipts)
            if (scenario === 'unload') {
              heldResponses.push(response)
              return
            }
            if (scenario === 'retry-after' && scenarioReceipts.length === 1) {
              response.statusCode = 429
              response.setHeader('retry-after', '1')
              response.end()
              return
            }
            response.statusCode = 202
            response.end()
          })
        })
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 4177,
    strictPort: true,
  },
})

function readBody(request: NodeJS.ReadableStream, done: (body: Buffer) => void): void {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  request.on('end', () => {
    done(Buffer.concat(chunks))
  })
}

function scenarioFromReplayPath(pathname: string): string {
  return /^\/replay\/([^/]+)(?:\/|$)/u.exec(pathname)?.[1] ?? 'unknown'
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}
