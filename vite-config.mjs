import { copyFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * Shared vite library config.
 *
 * `entry` may be either:
 *   - a string (single entry, output `dist/index.{js,cjs,d.ts,d.cts}`)
 *   - a `Record<string, string>` mapping entry name → absolute path. Each entry is built
 *     to `dist/<name>.{js,cjs,d.ts,d.cts}`.
 */
export default (entry, external = []) =>
  defineConfig({
    build: {
      lib: {
        entry,
        fileName: (format, entryName) => {
          const base = typeof entry === 'string' ? 'index' : entryName
          return format === 'cjs' ? `${base}.cjs` : `${base}.js`
        },
        formats: ['es', 'cjs'],
      },
      minify: true,
      rollupOptions: {
        external: (id) => {
          return id.startsWith('@opentelemetry') || id.startsWith('node:') || external.includes(id)
        },
        output: {
          exports: 'named',
        },
      },
    },
    define: {
      PACKAGE_TIMESTAMP: new Date().getTime(),
      PACKAGE_VERSION: JSON.stringify(process.env.npm_package_version || '0.0.0'),
    },
    plugins: [
      dts({
        // https://github.com/arethetypeswrong
        // https://github.com/qmhc/vite-plugin-dts/issues/267#issuecomment-1786996676
        afterBuild: () => {
          // To pass publint (`npm x publint@latest`) and ensure the
          // package is supported by all consumers, we must export types that are
          // read as ESM. To do this, there must be duplicate types with the
          // correct extension supplied in the package.json exports field.
          const names = typeof entry === 'string' ? ['index'] : Object.keys(entry)
          for (const name of names) {
            const src = `dist/${name}.d.ts`
            if (existsSync(src)) {
              copyFileSync(src, `dist/${name}.d.cts`)
            }
          }
        },
        compilerOptions: { skipLibCheck: true },
        rollupTypes: true,
        staticImport: true,
      }),
    ],
  })
