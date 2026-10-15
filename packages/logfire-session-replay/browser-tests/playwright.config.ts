import { resolve } from 'node:path'

import { defineConfig } from '@playwright/test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureServers: { command: string; env?: Record<string, string>; url: string }[] = [
  {
    command: 'pnpm exec vp dev --config packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts',
    url: 'http://127.0.0.1:4177/',
  },
  {
    command: 'pnpm exec vp dev --config packages/logfire-browser/test-fixtures/privacy-defaults/vite.config.ts',
    url: 'http://127.0.0.1:4178/',
  },
  {
    command: 'pnpm exec vp dev --config packages/logfire-browser/test-fixtures/rum-dimensions/vite.config.ts',
    url: 'http://127.0.0.1:4180/receipts',
  },
  {
    command: 'pnpm exec vp dev --config packages/logfire-browser/test-fixtures/soft-navigation-web-vitals/vite.config.ts',
    url: 'http://127.0.0.1:4182/',
  },
  {
    command: 'pnpm exec vp dev --config packages/logfire-browser/test-fixtures/errors-profile/vite.config.ts',
    url: 'http://127.0.0.1:4184/receipts',
  },
  ...['react-router', 'tanstack-router', 'vue-router'].map((example, index) => ({
    command: `pnpm exec vp dev --config examples/${example}/vite.config.ts`,
    // router-examples.pw.ts answers for this origin, so the examples export locally.
    env: { VITE_LOGFIRE_BASE_URL: 'http://logfire.test', VITE_LOGFIRE_TOKEN: 'router-example-token' },
    url: `http://127.0.0.1:${String(4186 + index)}/`,
  })),
]

// The recording identity flows also run in Firefox and WebKit when the environment asks for the
// full matrix. CI installs those browsers. A developer machine may not run them.
const identityBrowsers = process.env['REPLAY_BROWSER_MATRIX'] === 'all' ? (['firefox', 'webkit'] as const) : []

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: process.env['CI'] !== undefined,
  fullyParallel: false,
  outputDir: resolve(repositoryRoot, 'test-results'),
  reporter: process.env['CI'] === undefined ? 'line' : [['github'], ['line']],
  testDir: '.',
  testMatch: '*.pw.ts',
  timeout: 30_000,
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    ...identityBrowsers.map((browserName) => ({
      name: browserName,
      use: { browserName },
      testMatch: 'session-replay.pw.ts',
      grep: /recording identity/u,
    })),
  ],
  webServer: fixtureServers.map(({ command, env, url }) => ({
    command,
    ...(env === undefined ? {} : { env }),
    cwd: repositoryRoot,
    reuseExistingServer: false,
    timeout: 30_000,
    url,
  })),
  workers: 1,
})
