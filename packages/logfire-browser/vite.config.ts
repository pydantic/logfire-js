import { resolve } from 'node:path'

import defineConfig from '../../vite-config.mjs'

export default defineConfig(
  {
    evals: resolve(__dirname, 'src/evals.ts'),
    index: resolve(__dirname, 'src/index.ts'),
  },
  ['logfire', 'logfire/evals']
)
