import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

interface Receipt {
  body: string
  kind: 'trace' | 'replay'
  url: string
}

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(fixtureDirectory, '../..')
const recorderEntrypoint = resolve(packageDirectory, '../logfire-session-replay/dist/index.js')
const require = createRequire(recorderEntrypoint)
const rrwebEntrypoint = require.resolve('rrweb').replace(/dist\/rrweb\.cjs$/u, 'dist/rrweb.js')
const fflateEntrypoint = resolve(dirname(require.resolve('fflate/package.json')), 'esm/browser.js')
const recorderModuleId = 'lf-privacy-recorder'
const resolvedRecorderModuleId = `\0${recorderModuleId}`
const receipts: Receipt[] = []

function loadRecorderModule(): string {
  return readFileSync(recorderEntrypoint, 'utf8')
    .replaceAll('from"rrweb"', `from${JSON.stringify(rrwebEntrypoint)}`)
    .replaceAll('from"fflate"', `from${JSON.stringify(fflateEntrypoint)}`)
}

export default defineConfig({
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-privacy-recorder-runtime',
      resolveId(id) {
        return id === recorderModuleId ? resolvedRecorderModuleId : undefined
      },
      load(id) {
        return id === resolvedRecorderModuleId ? loadRecorderModule() : undefined
      },
    },
    {
      name: 'logfire-privacy-receipts',
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
            response.statusCode = 200
            response.setHeader('content-length', '2')
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
    port: 4178,
    strictPort: true,
  },
})

function endpointKind(pathname: string): Receipt['kind'] | undefined {
  if (pathname.endsWith('/client-traces')) {
    return 'trace'
  }
  if (/\/client-replay\/[^/]+$/u.test(pathname)) {
    return 'replay'
  }
  return undefined
}
