import { resolve } from 'node:path'
import { defineConfig } from 'vite-plus'

export interface Receipts {
  spans: { spanId: string; name: string }[]
  uploads: { bytes: number; complete: boolean; aborted: boolean }[]
}

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@pydantic/logfire-browser': resolve(import.meta.dirname, '../../../packages/logfire-browser/dist/index.js'),
    },
  },
  server: { host: '127.0.0.1', port: 4194, strictPort: true, ws: false },
  plugins: [
    {
      name: 'quick-redirect-resources',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/resource/')) {
            next()
            return
          }
          response.setHeader('content-type', 'image/svg+xml')
          response.setHeader('cache-control', 'no-store')
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
        })
      },
    },
  ],
})
