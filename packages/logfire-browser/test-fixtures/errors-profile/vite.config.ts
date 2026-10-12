import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

interface Receipt {
  body: string
  kind: 'trace' | 'metric' | 'replay'
  url: string
}

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(fixtureDirectory, '../..')
const recorderEntrypoint = resolve(packageDirectory, '../logfire-session-replay/dist/index.js')
const require = createRequire(recorderEntrypoint)
const rrwebEntrypoint = require.resolve('@rrweb/record').replace(/dist\/record\.cjs$/u, 'dist/record.js')
const fflateEntrypoint = resolve(dirname(require.resolve('fflate/package.json')), 'esm/browser.js')
const recorderModuleId = 'lf-errors-profile-recorder'
const resolvedRecorderModuleId = `\0${recorderModuleId}`
const receipts: Receipt[] = []

function loadRecorderModule(): string {
  return readFileSync(recorderEntrypoint, 'utf8')
    .replaceAll('from"@rrweb/record"', `from${JSON.stringify(rrwebEntrypoint)}`)
    .replaceAll('from"fflate"', `from${JSON.stringify(fflateEntrypoint)}`)
}

export default defineConfig({
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-errors-profile-recorder-runtime',
      resolveId(id) {
        return id === recorderModuleId ? resolvedRecorderModuleId : undefined
      },
      load(id) {
        return id === resolvedRecorderModuleId ? loadRecorderModule() : undefined
      },
    },
    {
      name: 'logfire-errors-profile-receipts',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (request.method === 'GET' && url.pathname === '/receipts') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ receipts }))
            return
          }
          if (request.method === 'POST' && url.pathname === '/receipts/reset') {
            receipts.length = 0
            response.statusCode = 204
            response.end()
            return
          }
          if (url.pathname.startsWith('/api/')) {
            response.statusCode = url.pathname === '/api/fail' ? 500 : 200
            response.setHeader('content-type', 'application/json')
            response.end('{}')
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
              kind,
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
    port: 4184,
    strictPort: true,
  },
})

// configureFrontend() derives the direct ingest endpoints from baseUrl.
function endpointKind(pathname: string): Receipt['kind'] | undefined {
  if (pathname === '/v1/traces') {
    return 'trace'
  }
  if (pathname === '/v1/metrics') {
    return 'metric'
  }
  if (/^\/v1\/replay\/[^/]+$/u.test(pathname)) {
    return 'replay'
  }
  return undefined
}
