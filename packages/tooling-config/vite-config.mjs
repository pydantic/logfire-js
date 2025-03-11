import { copyFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default (entry, external = []) => defineConfig({
  build: {
    lib: {
      entry,
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    minify: true,
    rollupOptions: {
      external: (id) => {
        return id.startsWith('@opentelemetry') || external.includes(id)
      },
      output: {
        exports: 'named',
      },
    },
  },
  define: {
    PACKAGE_TIMESTAMP: new Date().getTime(),
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
        copyFileSync('dist/index.d.ts', 'dist/index.d.cts')
      },
      compilerOptions: { skipLibCheck: true },
      rollupTypes: true,
      staticImport: true,
    }),
  ],
})

