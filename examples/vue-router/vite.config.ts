import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: import.meta.dirname,
  // The compile-time flags that @vitejs/plugin-vue would otherwise define.
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  server: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
})
