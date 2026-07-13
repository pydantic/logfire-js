import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite-plus'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Keep the dev import URL neutral because browser privacy extensions can block
// module URLs containing "session-replay". Loading workspace dist output also
// needs rrweb's browser ESM build, not the CommonJS package entrypoint.
const recorderModuleId = 'lf-browser-recorder'
const resolvedRecorderModuleId = `\0${recorderModuleId}`
const packageEntrypoint = resolve(__dirname, '../../packages/logfire-session-replay/dist/index.js')
const require = createRequire(packageEntrypoint)
const rrwebEntrypoint = require.resolve('rrweb').replace(/dist\/rrweb\.cjs$/u, 'dist/rrweb.js')
const fflateEntrypoint = resolve(dirname(require.resolve('fflate/package.json')), 'esm/browser.js')

function loadRecorderModule(): string {
  return readFileSync(packageEntrypoint, 'utf8')
    .replaceAll('from"rrweb"', `from${JSON.stringify(rrwebEntrypoint)}`)
    .replaceAll('from"fflate"', `from${JSON.stringify(fflateEntrypoint)}`)
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const proxyTarget = developmentProxyTarget(env.LOGFIRE_PROXY_TARGET, 'http://127.0.0.1:8990')

  return {
    plugins: [
      {
        name: 'logfire-browser-recorder-runtime',
        resolveId(id) {
          return id === recorderModuleId ? resolvedRecorderModuleId : undefined
        },
        load(id) {
          if (id !== resolvedRecorderModuleId) {
            return undefined
          }
          return loadRecorderModule()
        },
      },
    ],
    server: {
      proxy: proxyRoutes(proxyTarget),
    },
    preview: {
      proxy: proxyRoutes(proxyTarget),
    },
  }
})

function proxyRoutes(target: string): Record<string, { target: string }> {
  return Object.fromEntries(['/api', '/client-traces', '/client-metrics', '/client-replay'].map((path) => [path, { target }]))
}

function developmentProxyTarget(value: string | undefined, fallback: string): string {
  const target = value ?? fallback
  const url = new URL(target)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== target) {
    throw new Error('LOGFIRE_PROXY_TARGET must be an http://127.0.0.1:<port> origin')
  }
  return target
}
