#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entrypoint = resolve(repoRoot, 'packages/logfire-node/dist/index.js')
const DURATION_MILLIS = 60_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (!existsSync(entrypoint)) {
  console.error('Missing built Node package at packages/logfire-node/dist/index.js')
  console.error('Run `pnpm run build` first, then run this script again.')
  process.exit(2)
}

if (process.env.LOGFIRE_TOKEN === undefined || process.env.LOGFIRE_TOKEN === '') {
  console.error('LOGFIRE_TOKEN is required so the demo can send telemetry to your Logfire project.')
  console.error('Example: LOGFIRE_TOKEN=... node scripts/demo-node-pending-span.mjs')
  process.exit(2)
}

const logfire = await import(pathToFileURL(entrypoint).href)
const runId = `pending-span-demo-${new Date().toISOString()}`

logfire.configure({
  console: false,
  metrics: false,
  nodeAutoInstrumentations: {},
  resourceAttributes: {
    'demo.name': 'pending-span',
    'demo.run_id': runId,
  },
  serviceName: 'logfire-js-pending-span-demo',
  serviceVersion: 'pending-span-demo',
  token: process.env.LOGFIRE_TOKEN,
  variables: false,
})

const span = logfire.startSpan(
  'pending span demo: long-running operation',
  {
    'demo.duration_ms': DURATION_MILLIS,
    'demo.run_id': runId,
  },
  {
    tags: ['pending-span-demo'],
  }
)

const { spanId, traceId } = span.spanContext()

console.log('Started a long-running Logfire span.')
console.log(`demo.run_id: ${runId}`)
console.log(`trace_id: ${traceId}`)
console.log(`real span_id: ${spanId}`)
console.log('')
console.log('Open the Logfire live view and search for:')
console.log(`  trace_id:${traceId}`)
console.log('or:')
console.log(`  demo.run_id=${runId}`)
console.log('')

try {
  await logfire.forceFlush({ timeoutMillis: 10_000 })
  console.log('Pending span flushed while the real span is still open.')
  console.log(`Keeping the real span open for ${DURATION_MILLIS}ms...`)

  await sleep(DURATION_MILLIS)

  span.setAttribute('demo.completed', true)
  span.end()
  console.log('Real span ended; flushing final span export.')
} finally {
  if (span.isRecording()) {
    span.setAttribute('demo.interrupted', true)
    span.end()
  }
  await logfire.shutdown({ timeoutMillis: 10_000 })
}

console.log('Done.')
