import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import { frustrationServers } from './frustration-servers'

export default defineConfig({
  ...base,
  testMatch: ['frustration.pw.ts', 'frustration-export.pw.ts', 'frustration-replay.pw.ts', 'frustration-http.pw.ts'],
  projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
  webServer: frustrationServers,
})
