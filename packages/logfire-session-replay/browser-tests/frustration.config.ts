import { defineConfig } from '@playwright/test'
import base from './playwright.config'

const servers = base.webServer
if (!Array.isArray(servers)) {
  throw new Error('Expected the demo and playback fixture servers')
}

// A focused command can verify the local-only playground without starting unrelated fixtures.
export default defineConfig({
  ...base,
  testMatch: ['frustration.pw.ts', 'frustration-export.pw.ts', 'frustration-replay.pw.ts', 'frustration-shop.pw.ts'],
  projects: ['chromium', 'firefox', 'webkit'].map((browserName) => ({
    name: browserName,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit' },
  })),
  // The playground, rrweb playback, and HTTP-backed checkout are the first three servers.
  webServer: servers.slice(0, 3),
})
