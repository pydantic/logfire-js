import { resolve } from 'node:path'

import defineConfig from '../../vite-config.mjs'

export default defineConfig(
  {
    evals: resolve(__dirname, 'src/evals/index.ts'),
    index: resolve(__dirname, 'src/index.ts'),
  },
  ['js-yaml', 'p-retry', 'zod']
)
