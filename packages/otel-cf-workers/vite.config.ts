import { defineConfig } from 'vite-plus'

const packageDefines = {
  PACKAGE_TIMESTAMP: String(Date.now()),
  PACKAGE_VERSION: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0'),
}

const config: ReturnType<typeof defineConfig> = defineConfig({
  define: packageDefines,
  pack: {
    define: packageDefines,
    dts: {
      resolver: 'tsc',
    },
    deps: {
      neverBundle: [/^@opentelemetry/u, /^node:/u],
    },
    entry: 'src/index.ts',
    format: ['esm'],
    minify: true,
    outExtensions: () => ({
      dts: '.d.ts',
      js: '.js',
    }),
  },
})

export default config
