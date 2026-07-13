import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

interface Receipt {
  body: string
  contentEncoding?: string | undefined
  contentType?: string | undefined
  kind: 'trace' | 'metric' | 'replay'
  receivedAt: number
  url: string
}

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(fixtureDirectory, '../..')
const recorderEntrypoint = resolve(packageDirectory, '../logfire-session-replay/dist/index.js')
const require = createRequire(recorderEntrypoint)
const rrwebEntrypoint = require.resolve('rrweb').replace(/dist\/rrweb\.cjs$/u, 'dist/rrweb.js')
const fflateEntrypoint = resolve(dirname(require.resolve('fflate/package.json')), 'esm/browser.js')
const recorderModuleId = 'lf-self-observation-recorder'
const resolvedRecorderModuleId = `\0${recorderModuleId}`
const receipts: Receipt[] = []
let applicationRequests = 0
let frozenReceipts: { applicationRequests: number; frozen: true; receipts: Receipt[] } | undefined

function loadRecorderModule(): string {
  return readFileSync(recorderEntrypoint, 'utf8')
    .replaceAll('from"rrweb"', `from${JSON.stringify(rrwebEntrypoint)}`)
    .replaceAll('from"fflate"', `from${JSON.stringify(fflateEntrypoint)}`)
}

export default defineConfig({
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-self-observation-recorder-runtime',
      resolveId(id) {
        return id === recorderModuleId ? resolvedRecorderModuleId : undefined
      },
      load(id) {
        return id === resolvedRecorderModuleId ? loadRecorderModule() : undefined
      },
    },
    {
      name: 'logfire-self-observation-receipts',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (request.method === 'GET' && url.pathname === '/receipts') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify(frozenReceipts ?? { applicationRequests, frozen: false, receipts }))
            return
          }
          if (request.method === 'GET' && url.pathname === '/receipts/status') {
            const fcpMetric = receipts.some(
              (receipt) => receipt.kind === 'metric' && Buffer.from(receipt.body, 'base64').includes('logfire.browser.web_vital.fcp')
            )
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ fcpMetric }))
            return
          }
          if (request.method === 'POST' && url.pathname === '/receipts/reset') {
            receipts.length = 0
            applicationRequests = 0
            frozenReceipts = undefined
            response.statusCode = 204
            response.end()
            return
          }
          if (request.method === 'POST' && url.pathname === '/receipts/freeze') {
            frozenReceipts = { applicationRequests, frozen: true, receipts: [...receipts] }
            response.statusCode = 204
            response.end()
            return
          }
          if (request.method === 'GET' && url.pathname.endsWith('/api/application')) {
            applicationRequests += 1
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ ok: true }))
            return
          }

          const kind = endpointKind(url.pathname)
          if (request.method !== 'POST' || kind === undefined) {
            next()
            return
          }
          const chunks: Buffer[] = []
          request.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          request.on('end', () => {
            receipts.push({
              body: Buffer.concat(chunks).toString('base64'),
              contentEncoding: headerValue(request.headers['content-encoding']),
              contentType: headerValue(request.headers['content-type']),
              kind,
              receivedAt: Date.now(),
              url: request.url ?? '/',
            })
            response.statusCode = 200
            response.setHeader('content-type', 'application/json')
            response.end('{}')
          })
        })
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
  },
})

function endpointKind(pathname: string): Receipt['kind'] | undefined {
  if (pathname.endsWith('/client-traces')) {
    return 'trace'
  }
  if (pathname.endsWith('/client-metrics')) {
    return 'metric'
  }
  if (/\/client-replay\/[^/]+$/u.test(pathname)) {
    return 'replay'
  }
  return undefined
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}
