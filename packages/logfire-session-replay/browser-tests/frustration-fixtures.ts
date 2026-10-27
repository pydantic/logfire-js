import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

export const frustrationTests = ['frustration.pw.ts', 'frustration-export.pw.ts', 'frustration-replay.pw.ts', 'frustration-http.pw.ts']

export const frustrationServers = [
  {
    command: 'pnpm exec vp dev --config packages/logfire-browser/test-fixtures/frustration/vite.config.ts',
    url: 'http://127.0.0.1:5190/',
  },
  {
    command: 'pnpm exec vp dev --config packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts',
    url: 'http://127.0.0.1:4177/',
  },
].map((server) => ({
  ...server,
  cwd: repositoryRoot,
  reuseExistingServer: false,
  timeout: 30_000,
}))
