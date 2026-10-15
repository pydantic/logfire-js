import { defineConfig } from 'vite-plus'

import { copyCjsDeclarations, packageDefines } from '../../vite.shared'

const defines = packageDefines(import.meta.url)

const config: ReturnType<typeof defineConfig> = defineConfig({
  define: defines,
  pack: {
    define: defines,
    dts: true,
    deps: {
      neverBundle: [/^@opentelemetry/u, /^node:/u, 'logfire'],
    },
    entry: {
      index: 'src/index.ts',
      'react-router': 'src/reactRouter.ts',
      'tanstack-router': 'src/tanstackRouter.ts',
      'vue-router': 'src/vueRouter.ts',
    },
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': () => {
        copyCjsDeclarations(['index', 'react-router', 'tanstack-router', 'vue-router'])
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
