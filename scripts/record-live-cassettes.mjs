#!/usr/bin/env node
// Re-record the Agent Control AI SDK adapter's live-provider cassettes.
//
//   node scripts/record-live-cassettes.mjs --env-file <path to a .env with provider keys>
//
// The env file needs OPENAI_API_KEY, ANTHROPIC_API_KEY, and GEMINI_API_KEY. It is loaded into this
// process with `process.loadEnvFile` and handed to the test process through its environment, so the
// values never appear on a command line, in a log, or in a cassette. Everything the recorder writes
// is in packages/logfire-agent-control-ai-sdk/src/__test__/cassettes/.
//
// Recording costs a handful of requests to the cheapest current model of each provider.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const flag = process.argv.indexOf('--env-file')
const envFile = flag === -1 ? undefined : process.argv[flag + 1]

if (envFile === undefined) {
  console.error('Usage: node scripts/record-live-cassettes.mjs --env-file <path>')
  process.exit(2)
}

process.loadEnvFile(envFile)

const missing = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].filter((name) => !process.env[name])
if (missing.length > 0) {
  console.error(`${envFile} does not define: ${missing.join(', ')}`)
  process.exit(2)
}

const { status } = spawnSync(
  'pnpm',
  ['--filter', '@pydantic/logfire-agent-control-ai-sdk', 'exec', 'vitest', 'run', 'src/__test__/live.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, LOGFIRE_CASSETTE_MODE: 'record' },
  }
)

process.exit(status ?? 1)
