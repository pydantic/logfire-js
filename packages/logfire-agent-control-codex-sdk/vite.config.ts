import { defineConfig } from 'vite-plus'

import { packageDefines } from '../../vite.shared'

const defines = packageDefines(import.meta.url)

const config: ReturnType<typeof defineConfig> = defineConfig({
  define: defines,
  pack: {
    define: defines,
    dts: {
      resolver: 'tsc',
    },
    deps: {
      neverBundle: [/^node:/u, '@openai/codex-sdk', '@pydantic/logfire-node', '@pydantic/logfire-node/agent-control'],
    },
    entry: 'src/index.ts',
    // ESM only, unlike every other package here: `@openai/codex-sdk` publishes no `require`
    // condition, so a CommonJS build of this adapter would be a build that cannot load its own peer.
    format: ['esm'],
    minify: true,
    // `.js` and `.d.ts` rather than the `.mjs` default an ESM-only build would otherwise take, so
    // the file names match every other package here; `"type": "module"` already makes `.js` ESM.
    outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
    outputOptions: {
      exports: 'named',
    },
  },
  test: {
    // Starting a `codex` process -- the stand-in binary in the offline suite, the real one in
    // `live-tests` -- is slower than an in-process assertion, and slower again on a loaded CI runner.
    testTimeout: 20_000,
  },
})

export default config
