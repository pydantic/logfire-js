import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

interface Receipt {
  body: string
  endpoint: 'a' | 'app' | 'b'
  receivedAt: number
}

const receipts = new Map<string, Receipt[]>()
const states = new Map<string, unknown>()
const fixtureDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: fixtureDirectory,
  plugins: [
    {
      name: 'logfire-provider-lifecycle-receipts',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const scenario = url.searchParams.get('scenario') ?? 'unknown'
          if (request.method === 'POST' && url.pathname === '/receipts/reset') {
            receipts.set(scenario, [])
            states.delete(scenario)
            response.statusCode = 204
            response.end()
            return
          }
          if (request.method === 'POST' && url.pathname === '/receipts/state') {
            const chunks: Buffer[] = []
            request.on('data', (chunk: Buffer) => {
              chunks.push(chunk)
            })
            request.on('end', () => {
              states.set(scenario, JSON.parse(Buffer.concat(chunks).toString('utf8')))
              response.statusCode = 204
              response.end()
            })
            return
          }
          if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
            const requestedScenario = url.pathname.slice('/receipts/'.length)
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ receipts: receipts.get(requestedScenario) ?? [], state: states.get(requestedScenario) }))
            return
          }
          const endpoint = traceEndpoint(url.pathname)
          if (request.method !== 'POST' || endpoint === undefined) {
            next()
            return
          }
          const chunks: Buffer[] = []
          request.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          request.on('end', () => {
            const scenarioReceipts = receipts.get(scenario) ?? []
            scenarioReceipts.push({
              body: Buffer.concat(chunks).toString('base64'),
              endpoint,
              receivedAt: Date.now(),
            })
            receipts.set(scenario, scenarioReceipts)
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
    port: 4176,
    strictPort: true,
  },
})

function traceEndpoint(pathname: string): Receipt['endpoint'] | undefined {
  if (pathname === '/traces/a') {
    return 'a'
  }
  if (pathname === '/traces/b') {
    return 'b'
  }
  if (pathname === '/traces/app') {
    return 'app'
  }
  return undefined
}
