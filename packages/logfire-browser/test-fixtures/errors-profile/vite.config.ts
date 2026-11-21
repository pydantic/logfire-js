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
const docsExamples = new Map([
  ['start', 'browser.md'],
  ['errors', 'browser/errors.md'],
  ['replay', 'browser/replay.md'],
])

function loadRecorderModule(): string {
  return readFileSync(recorderEntrypoint, 'utf8')
    .replaceAll('from"@rrweb/record"', `from${JSON.stringify(rrwebEntrypoint)}`)
    .replaceAll('from"fflate"', `from${JSON.stringify(fflateEntrypoint)}`)
}

export default defineConfig({
  root: fixtureDirectory,
  resolve: {
    alias: { '@rrweb/record': rrwebEntrypoint, fflate: fflateEntrypoint },
  },
  plugins: [
    {
      name: 'logfire-browser-doc-examples',
      resolveId(id) {
        return id.startsWith('virtual:browser-docs-') ? `\0${id}` : undefined
      },
      load(id) {
        const page = docsExamples.get(id.replace('\0virtual:browser-docs-', ''))
        if (page === undefined) {
          return undefined
        }
        const markdown = readFileSync(resolve(packageDirectory, '../../docs/packages', page), 'utf8')
        const sample = /^```ts\n([\s\S]*?)^```/mu.exec(markdown)?.[1]
        if (sample === undefined) {
          throw new Error(`Missing setup example: ${page}`)
        }
        // Execute the documented setup, changing only its destination/token and
        // retaining the returned handle so the harness can flush after use.
        const setup = sample
          .replace("'https://logfire-us.pydantic.dev'", 'window.location.origin')
          .replace("'<frontend-application-token>'", "'fixture-frontend-token'")
          .replace(/^logfire.configureFrontend\(/mu, 'const cleanup = logfire.configureFrontend(')
        return `${setup}
          document.querySelector('#healthy').addEventListener('click', () => logfire.info('healthy docs click'))
          document.querySelector('#handled').addEventListener('click', () => logfire.reportError('Checkout failed', new Error('docs handled')))
          document.querySelector('#uncaught').addEventListener('click', () => setTimeout(() => { throw new Error('docs uncaught') }))
          document.querySelector('#finish').addEventListener('click', async () => {
            await cleanup()
            document.querySelector('#status').textContent = 'complete'
          })
          const timer = setInterval(() => {
            if (!cleanup.sessionReplay || cleanup.sessionReplay.recording) {
              clearInterval(timer)
              document.querySelector('#status').textContent = 'ready'
            }
          }, 20)
        `
      },
    },
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
          const docsPage = /^\/docs\/(start|errors|replay)\.html$/u.exec(url.pathname)?.[1]
          if (request.method === 'GET' && docsPage !== undefined) {
            response.setHeader('content-type', 'text/html')
            response.end(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Browser docs dry run</title></head>
              <body><main><h1>Browser docs dry run</h1><p id="status">starting</p><p>Private checkout text</p>
              <button id="healthy">Healthy click</button><button id="handled">Handled error</button>
              <button id="uncaught">Uncaught error</button><button id="finish">Finish</button></main>
              <script type="module" src="/@id/virtual:browser-docs-${docsPage}"></script></body></html>`)
            return
          }
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
