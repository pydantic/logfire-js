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
