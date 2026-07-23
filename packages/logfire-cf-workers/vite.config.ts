import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite-plus'

const { version: packageVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

const packageDefines = {
  PACKAGE_TIMESTAMP: String(Date.now()),
  PACKAGE_VERSION: JSON.stringify(packageVersion),
}

const config: ReturnType<typeof defineConfig> = defineConfig({
  define: packageDefines,
  pack: {
    define: packageDefines,
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
