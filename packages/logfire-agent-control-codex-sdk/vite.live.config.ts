import { defineConfig } from 'vite-plus'

/**
 * The live suite: real `codex` processes against a real model, run by hand.
 *
 * Kept out of `vp test` by its own config and its own `.live.ts` suffix -- the same way
 * `@pydantic/logfire-session-replay` keeps its Playwright specs out with `.pw.ts` -- so CI stays
 * offline by construction rather than by a skip nobody notices went permanent. Run it with
 * `vp run @pydantic/logfire-agent-control-codex-sdk#test:live` on a machine where `codex` is
 * installed and logged in; see `live-tests/README.md`.
 */
const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    include: ['live-tests/**/*.live.ts'],
    // A real turn on a real model, and three of them in one file.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})

export default config
