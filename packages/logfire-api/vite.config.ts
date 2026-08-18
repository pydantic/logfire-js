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
      neverBundle: [/^@opentelemetry/u, /^node:/u, 'handlebars', 'js-yaml', 'p-retry', 'zod'],
    },
    entry: {
      cli: 'src/cli/index.ts',
      datasets: 'src/datasets/index.ts',
      evals: 'src/evals/index.ts',
      index: 'src/index.ts',
      vars: 'src/vars/index.ts',
      'vars/reference-syntax': 'src/vars/reference-syntax.ts',
    },
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': () => {
        copyCjsDeclarations(['cli', 'datasets', 'evals', 'index', 'vars', 'vars/reference-syntax'])
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
