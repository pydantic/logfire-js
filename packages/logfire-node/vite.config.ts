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

const config: ReturnType<typeof defineConfig> = defineConfig({
  define: packageDefines,
  pack: {
    define: packageDefines,
    dts: {
      resolver: 'tsc',
    },
    deps: {
      neverBundle: [/^@opentelemetry/, /^node:/, 'logfire', 'logfire/evals', 'logfire/vars', 'picocolors'],
    },
    entry: {
      index: 'src/index.ts',
      vars: 'src/vars.ts',
    },
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': () => {
        copyCjsDeclarations(['index', 'vars'])
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
