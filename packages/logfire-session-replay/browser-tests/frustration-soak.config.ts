import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from './frustration.config'

export default defineConfig({
  ...base,
  testMatch: 'frustration.soak.ts',
  outputDir: resolve(import.meta.dirname, '../../../reports/frustration-soak'),
  reporter: [['line'], ['json', { outputFile: resolve(import.meta.dirname, '../../../reports/frustration-soak/report.json') }]],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  timeout: 15 * 60000,
})
