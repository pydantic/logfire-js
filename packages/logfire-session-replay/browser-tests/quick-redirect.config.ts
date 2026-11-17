import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import { quickRedirectServers } from './quick-redirect-fixtures'

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
  webServer: quickRedirectServers.map((server) => ({
    ...server,
    cwd: repositoryRoot,
    reuseExistingServer: false,
  })),
})
