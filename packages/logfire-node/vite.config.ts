import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite-plus'

const { version: packageVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

const packageDefines = {
  PACKAGE_TIMESTAMP: String(Date.now()),
  PACKAGE_VERSION: JSON.stringify(packageVersion),
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
