import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import { frustrationServers, frustrationTests } from './frustration-fixtures'

export default defineConfig({
  ...base,
  testMatch: frustrationTests,
  projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
  webServer: frustrationServers,
})
