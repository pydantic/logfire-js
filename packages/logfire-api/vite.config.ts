import { resolve } from 'node:path'

import defineConfig from '../../vite-config.mjs'

export default defineConfig(resolve(__dirname, 'src/index.ts'))
