import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite-plus'

const { version: packageVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

const packageDefines = {
  PACKAGE_TIMESTAMP: String(Date.now()),
  PACKAGE_VERSION: JSON.stringify(packageVersion),
}

const copyCjsDeclarations = () => {
  if (existsSync('dist/index.d.ts')) {
    copyFileSync('dist/index.d.ts', 'dist/index.d.cts')
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
      neverBundle: [/^node:/u],
    },
    entry: 'src/index.ts',
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': copyCjsDeclarations,
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
