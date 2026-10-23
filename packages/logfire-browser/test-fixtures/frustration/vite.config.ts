import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { defineConfig } from 'vite-plus'
import type { FrustrationReceipts, FrustrationSpan } from './receipts.types'
import type { ChunkEnvelope } from '../../../logfire-session-replay/dist/index.js'

const evidence: FrustrationReceipts = { spans: [], chunks: [] }
let storedBytes = 0
// The installed OTel transport leaves response bodies unread. With no-store,
// Chromium can retain keepalive quota: https://github.com/open-telemetry/opentelemetry-js/issues/7001
// Keep the local fixture usable, but retain a switch for reproducing that SDK bug.
const ingestCacheControl = process.env['FRUSTRATION_NO_STORE'] === '1' ? 'no-store' : 'no-cache'

// Development-only, bounded, in-memory HTTP receiver. Not a production ingest service.
const config: ReturnType<typeof defineConfig> = defineConfig({
  root: import.meta.dirname,
  cacheDir: resolve(import.meta.dirname, '../../node_modules/.vite-frustration'),
  // An open Vite WebSocket prevents the native BFCache safety test from restoring this document.
  server: { host: '127.0.0.1', port: 5190, strictPort: true, ws: false, forwardConsole: false },
  plugins: [
    {
      name: 'frustration-fixture-http',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1:5190')
          const json = (status: number, data: unknown) => {
            response.statusCode = status
            response.setHeader('content-type', 'application/json')
            response.setHeader('cache-control', url.pathname.startsWith('/v1/') ? ingestCacheControl : 'no-store')
            response.end(JSON.stringify(data))
          }
          if (request.method === 'POST' && url.pathname === '/fixture/reset') {
            evidence.spans.length = 0
            evidence.chunks.length = 0
            storedBytes = 0
            json(200, {})
            return
          }
          if (request.method === 'GET' && url.pathname === '/fixture/receipts') {
            json(200, evidence)
            return
          }
          if (request.method === 'GET' && url.pathname === '/fixture/shipping') {
            const timer = setTimeout(() => {
              json(200, { estimate: 'Free delivery · arrives Thursday' })
            }, 3400)
            response.on('close', () => {
              clearTimeout(timer)
            })
            return
          }
          if (request.method === 'GET' && url.pathname === '/fixture/cart') {
            json(200, { added: true })
            return
          }
          if (request.method !== 'POST' || !/^\/v1\/(?:traces|metrics|replay\/[^/]+)$/u.test(url.pathname)) {
            next()
            return
          }
          const buffers: Buffer[] = []
          let size = 0
          request.on('data', (chunk: Buffer) => {
            size += chunk.byteLength
            if (size <= 1000000) {
              buffers.push(chunk)
            } else if (!response.writableEnded) {
              json(413, { error: 'Fixture upload exceeds 1 MB' })
            }
          })
          request.on('end', () => {
            if (response.writableEnded) {
              return
            }
            try {
              const body = Buffer.concat(buffers)
              if (url.pathname.startsWith('/v1/replay/')) {
                if (storedBytes + body.byteLength > 12000000) {
                  json(503, { error: 'Fixture storage full; restart the fixture server' })
                  return
                }
                const decoded = gunzipSync(body, { maxOutputLength: 4000000 })
                if (storedBytes + decoded.byteLength > 12000000) {
                  json(503, { error: 'Fixture storage full; restart the fixture server' })
                  return
                }
                const envelope = JSON.parse(decoded.toString('utf8')) as ChunkEnvelope
                if (!Array.isArray(envelope.events) || envelope.meta.seq !== Number(url.searchParams.get('seq'))) {
                  throw new Error('Invalid replay envelope')
                }
                evidence.chunks.push({ id: url.pathname.split('/').at(-1) ?? '', seq: envelope.meta.seq, events: envelope.events })
                storedBytes += decoded.byteLength
              } else if (url.pathname === '/v1/traces') {
                const payload = JSON.parse(body.toString('utf8')) as { resourceSpans: { scopeSpans: { spans: FrustrationSpan[] }[] }[] }
                evidence.spans.push(...payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
                evidence.spans.splice(0, Math.max(0, evidence.spans.length - 1000))
              }
              json(200, {})
            } catch {
              json(400, { error: 'Invalid fixture telemetry payload' })
            }
          })
          request.on('error', () => {
            if (!response.writableEnded) {
              json(400, { error: 'Interrupted upload' })
            }
          })
        })
      },
    },
  ],
})
export default config
