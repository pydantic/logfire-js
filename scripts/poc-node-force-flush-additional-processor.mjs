#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entrypoint = resolve(repoRoot, 'packages/logfire-node/dist/index.js')

if (!existsSync(entrypoint)) {
  console.error('Missing built Node package at packages/logfire-node/dist/index.js')
  console.error('Run `pnpm run build` first, then run this script again.')
  process.exit(2)
}

const { configure, forceFlush, shutdown } = await import(pathToFileURL(entrypoint).href)

const counters = {
  forceFlush: 0,
  shutdown: 0,
}

const additionalProcessor = {
  async forceFlush() {
    counters.forceFlush++
  },
  onEnd() {},
  onStart() {},
  async shutdown() {
    counters.shutdown++
  },
}

const results = []

function check(name, passed, detail) {
  results.push({ detail, name, passed })
  const mark = passed ? 'PASS' : 'FAIL'
  console.log(`${mark} ${name}${detail ? ` (${detail})` : ''}`)
}

try {
  configure({
    additionalSpanProcessors: [additionalProcessor],
    console: false,
    metrics: false,
    nodeAutoInstrumentations: {},
    sendToLogfire: false,
    variables: false,
  })

  // Keep this span-free. Queued spans with sendToLogfire=false currently exercise
  // the void exporter path, which is a separate flush timeout issue.
  await forceFlush()

  check(
    'public forceFlush reaches additional span processors',
    counters.forceFlush > 0,
    `additional forceFlush calls=${counters.forceFlush}`
  )

  await shutdown()

  check('NodeSDK shutdown reaches the same additional span processor', counters.shutdown > 0, `shutdown calls=${counters.shutdown}`)
} finally {
  await shutdown().catch(() => undefined)
}

const failed = results.filter((result) => !result.passed)
console.log('')
console.log(`Summary: ${results.length - failed.length}/${results.length} checks passed`)

if (failed.length > 0) {
  console.log('Current behavior is broken for:')
  for (const result of failed) {
    console.log(`- ${result.name}`)
  }
  process.exit(1)
}
