import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const receipts: string[] = []
let state: unknown

export default defineConfig({
  resolve: {
    alias: {
      'web-vitals/attribution': resolve(fixtureDirectory, 'webVitalsRecorder.ts'),
    },
  },
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-optional-feature-api-receipts',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (request.method === 'POST' && url.pathname === '/receipts/reset') {
            receipts.length = 0
            state = undefined
            response.statusCode = 204
            response.end()
            return
          }
          if (request.method === 'POST' && url.pathname === '/receipts/state') {
            readBody(request, (body) => {
              state = JSON.parse(body)
              response.statusCode = 204
              response.end()
            })
            return
          }
          if (request.method === 'GET' && url.pathname === '/receipts') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ receipts, state }))
            return
          }
          if (request.method === 'POST' && url.pathname.startsWith('/traces/')) {
            readBody(request, (body) => {
              receipts.push(body)
              response.statusCode = 200
              response.setHeader('content-type', 'application/json')
              response.end('{}')
            })
            return
          }
          next()
        })
      },
    },
  ],
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
})

function readBody(request: NodeJS.ReadableStream, done: (body: string) => void): void {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  request.on('end', () => {
    done(Buffer.concat(chunks).toString('utf8'))
  })
}
