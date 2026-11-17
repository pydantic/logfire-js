import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  testDir: '.',
  testMatch: 'quick-redirect.pw.ts',
  timeout: 45_000,
  expect: { timeout: 25_000 },
  workers: 1,
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,
  outputDir: resolve(repositoryRoot, 'test-results/quick-redirect'),
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'python3 examples/browser/quick-redirect/collector.py',
      cwd: repositoryRoot,
      url: 'http://127.0.0.1:4195/receipts/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vp dev --config examples/browser/quick-redirect/vite.config.ts',
      cwd: repositoryRoot,
      url: 'http://127.0.0.1:4194/',
      reuseExistingServer: false,
    },
  ],
})
