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
      neverBundle: [/^@opentelemetry/u, /^node:/u, '@pydantic/otel-cf-workers', 'logfire'],
    },
    entry: 'src/index.ts',
    format: ['esm'],
    minify: true,
    outExtensions: () => ({
      dts: '.d.ts',
      js: '.js',
    }),
    outputOptions: {
      exports: 'named',
    },
  },
})

export default config
