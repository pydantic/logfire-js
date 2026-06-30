import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

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

export default defineConfig({
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
})
