import { defineConfig } from 'vite-plus'

import { copyCjsDeclarations, packageDefines } from '../../vite.shared'

const defines = packageDefines(import.meta.url)

const config: ReturnType<typeof defineConfig> = defineConfig({
  define: defines,
  pack: {
    define: defines,
    dts: {
      resolver: 'tsc',
    },
    deps: {
      neverBundle: [/^@opentelemetry/u, /^node:/u, 'logfire', 'logfire/datasets', 'logfire/evals', 'logfire/vars', 'picocolors'],
    },
    entry: {
      datasets: 'src/datasets.ts',
      index: 'src/index.ts',
      vars: 'src/vars.ts',
    },
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': () => {
        copyCjsDeclarations(['datasets', 'index', 'vars'])
      },
    },
    minify: true,
    outExtensions: ({ format }) => ({
      dts: format === 'cjs' ? '.d.cts' : '.d.ts',
      js: format === 'cjs' ? '.cjs' : '.js',
    }),
    outputOptions: {
      exports: 'named',
    },
  },
})

export default config
