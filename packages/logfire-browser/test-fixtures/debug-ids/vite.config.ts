import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

interface Receipt {
  body: string
  url: string
}

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const receipts: Receipt[] = []

export default defineConfig({
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-debug-ids-receipts',
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
          if (request.method !== 'POST' || url.pathname !== '/v1/traces') {
            next()
            return
          }
          const chunks: Buffer[] = []
          request.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          request.on('end', () => {
            receipts.push({ body: Buffer.concat(chunks).toString('base64'), url: request.url ?? '/' })
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
    port: 4192,
    strictPort: true,
  },
})
