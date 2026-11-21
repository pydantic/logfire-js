import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: import.meta.dirname,
  server: {
    host: '127.0.0.1',
    port: 4186,
    strictPort: true,
  },
})
