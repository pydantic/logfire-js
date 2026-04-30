import { copyFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'vite-plus'

const packageDefines = {
  PACKAGE_TIMESTAMP: String(Date.now()),
  PACKAGE_VERSION: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0'),
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
      neverBundle: [/^@opentelemetry/, /^node:/, '@pydantic/otel-cf-workers', 'logfire'],
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
