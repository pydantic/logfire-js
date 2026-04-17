import { resolve } from 'node:path'

import defineConfig from '../../vite-config.mjs'

const config = defineConfig(resolve(__dirname, 'src/index.ts'), ['yaml', 'node:async_hooks'])

// Preserve class/function names so `this.constructor.name` works for user-defined Evaluator subclasses.
config.esbuild = {
  ...(config.esbuild ?? {}),
  keepNames: true,
}

export default config
