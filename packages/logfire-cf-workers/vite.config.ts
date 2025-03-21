import defineConfig from '@pydantic/logfire-tooling-config/vite-config'
import { resolve } from 'node:path'

export default defineConfig(resolve(__dirname, 'src/index.ts'), ['@microlabs/otel-cf-workers'])
