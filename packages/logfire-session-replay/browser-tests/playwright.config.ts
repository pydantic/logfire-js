import { resolve } from 'node:path'

import { defineConfig } from '@playwright/test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureServers = [
  {
    command: 'pnpm exec vp dev --config packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts',
    url: 'http://127.0.0.1:4177/',
  },
  {
    command: 'pnpm exec vp dev --config packages/logfire-browser/test-fixtures/privacy-defaults/vite.config.ts',
    url: 'http://127.0.0.1:4178/',
  },
]

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: process.env['CI'] !== undefined,
  fullyParallel: false,
  outputDir: resolve(repositoryRoot, 'test-results'),
  reporter: process.env['CI'] === undefined ? 'line' : [['github'], ['line']],
  testDir: '.',
  testMatch: 'session-replay.pw.ts',
  timeout: 30_000,
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: fixtureServers.map(({ command, url }) => ({
    command,
    cwd: repositoryRoot,
    reuseExistingServer: false,
    timeout: 30_000,
    url,
  })),
  workers: 1,
})
