import { copyFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'vite-plus'

const packageDefines = {
  PACKAGE_TIMESTAMP: String(Date.now()),
  PACKAGE_VERSION: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0'),
}

const copyCjsDeclarations = (names: string[]) => {
  for (const name of names) {
    const src = `dist/${name}.d.ts`
    if (existsSync(src)) {
      copyFileSync(src, `dist/${name}.d.cts`)
    }
  }
}

export default defineConfig({
  define: packageDefines,
  pack: {
    define: packageDefines,
    dts: {
      resolver: 'tsc',
    },
    deps: {
      neverBundle: [/^@opentelemetry/, /^node:/, 'js-yaml', 'p-retry', 'zod'],
    },
    entry: {
      evals: 'src/evals/index.ts',
      index: 'src/index.ts',
    },
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': () => {
        copyCjsDeclarations(['evals', 'index'])
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
