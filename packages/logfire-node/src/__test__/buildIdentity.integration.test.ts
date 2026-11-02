import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { configure, reportError, shutdown } from '../index'

// Stands in for what the inject snippet writes when a bundle loads.
function setGlobal(name: '_debugIds' | '_logfireDebugIds' | '_logfireRelease', value: unknown): void {
  Reflect.set(globalThis, name, value)
}
const BUNDLE_PATH = '/app/dist/server.js'
const DEBUG_ID = 'c0ffee00-1d2e-4f3a-9b8c-7d6e5f4a3b2c'
// What the inject snippet captures with `new Error().stack` as the first statement of a CommonJS bundle.
const REGISTRY_KEY = `Error\n    at Object.<anonymous> (${BUNDLE_PATH}:1:60)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)`
const EXPECTED = `{"${BUNDLE_PATH}":"${DEBUG_ID}"}`

function bundleError(message: string): Error {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at chargeCard (${BUNDLE_PATH}:3:9)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`
  return error
}

function start(options: Parameters<typeof configure>[0] = {}): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter()
  configure({
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
    metrics: false,
    nodeAutoInstrumentations: {},
    sendToLogfire: false,
    serviceName: 'build-identity-itest',
    ...options,
  })
  return exporter
}

describe('node build identity', () => {
  afterEach(async () => {
    await shutdown()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    Reflect.deleteProperty(globalThis, '_logfireDebugIds')
    Reflect.deleteProperty(globalThis, '_logfireRelease')
  })

  it('stamps debug IDs on reportError() and on exceptions instrumentations record', () => {
    setGlobal('_logfireDebugIds', { [REGISTRY_KEY]: DEBUG_ID })
    const exporter = start()

    reportError('Charge failed', bundleError('declined'))
    const instrumented = trace.getTracer('instrumentation').startSpan('POST /charge')
    instrumented.recordException(bundleError('declined'))
    instrumented.end()

    expect(
      exporter.getFinishedSpans().map((span) => ({
        event: span.events.find((event) => event.name === 'exception')?.attributes?.['logfire.debug_ids'],
        name: span.name,
        span: span.attributes['logfire.debug_ids'],
      }))
    ).toEqual([
      { event: EXPECTED, name: 'Charge failed', span: EXPECTED },
      { event: EXPECTED, name: 'POST /charge', span: EXPECTED },
    ])
  })

  it('uses the injected release as service.version after the configured value and environment', () => {
    vi.stubEnv('LOGFIRE_SERVICE_VERSION', '')
    vi.stubEnv('OTEL_SERVICE_VERSION', '')
    setGlobal('_logfireRelease', '9f3c2ab')
    const fromRelease = start()
    reportError('Charge failed', bundleError('declined'))

    vi.stubEnv('LOGFIRE_SERVICE_VERSION', 'env-version')
    const fromEnv = start()
    reportError('Charge failed', bundleError('declined'))

    const fromOption = start({ serviceVersion: 'option-version' })
    reportError('Charge failed', bundleError('declined'))

    expect(
      [fromRelease, fromEnv, fromOption].map((exporter) => exporter.getFinishedSpans()[0]?.resource.attributes['service.version'])
    ).toEqual(['9f3c2ab', 'env-version', 'option-version'])
  })

  it('enables Node source maps only when enableSourceMaps is true', () => {
    const setSourceMapsEnabled = vi.spyOn(process, 'setSourceMapsEnabled').mockImplementation(() => undefined)

    start()
    start({ enableSourceMaps: false })
    start({ enableSourceMaps: true })

    expect(setSourceMapsEnabled.mock.calls).toEqual([[true]])
  })
})

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function vlq(...values: number[]): string {
  let encoded = ''
  for (const value of values) {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1
    do {
      let digit = rest & 31
      rest >>>= 5
      if (rest > 0) {
        digit |= 32
      }
      encoded += BASE64.charAt(digit)
    } while (rest > 0)
  }
  return encoded
}

// A built CommonJS file with its map beside it, as a Node service ships it.
function writeMappedBuild(root: string): string {
  mkdirSync(join(root, 'dist'))
  const generated = join(root, 'dist', 'server.js')
  writeFileSync(
    generated,
    [
      "'use strict'",
      'function chargeCard() {',
      "  throw new Error('card declined')",
      '}',
      'module.exports = { chargeCard }',
      '//# sourceMappingURL=server.js.map',
    ].join('\n')
  )
  // Generated line 2 maps to original line 40, and the throw on line 3 to original line 42, column 5.
  const map = {
    mappings: `;${vlq(0, 0, 39, 0)};${vlq(2, 0, 2, 4)};;`,
    names: [],
    sources: ['../src/payments/charge.ts'],
    version: 3,
  }
  writeFileSync(join(root, 'dist', 'server.js.map'), JSON.stringify(map))
  return generated
}

// Runs in a fresh process because Vitest replaces Error.prepareStackTrace, which turns Node's own mapping off.
function stackFromChildProcess(generated: string, enableSourceMaps: boolean): string {
  const sdkEntrypoint = resolve(import.meta.dirname, '../../dist/index.js')
  const script = `
    import { createRequire } from 'node:module'
    import { configure, shutdown } from ${JSON.stringify(sdkEntrypoint)}
    configure({ enableSourceMaps: ${String(enableSourceMaps)}, metrics: false, nodeAutoInstrumentations: {}, sendToLogfire: false })
    const { chargeCard } = createRequire(import.meta.url)(${JSON.stringify(generated)})
    try {
      chargeCard()
    } catch (error) {
      process.stdout.write(error.stack)
    }
    await shutdown()
  `
  const env = { ...process.env }
  delete env['NODE_OPTIONS']
  delete env['LOGFIRE_TOKEN']
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 30_000 })
}

describe('enableSourceMaps in a Node process', () => {
  it('rewrites Error.stack to the original source file and line', () => {
    // Node reports the resolved path, and the macOS temp directory is a symlink.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'logfire-node-source-maps-')))
    try {
      const generated = writeMappedBuild(root)

      const mapped = stackFromChildProcess(generated, true).split('\n').slice(0, 2)
      const unmapped = stackFromChildProcess(generated, false).split('\n').slice(0, 2)

      expect(mapped).toEqual(['Error: card declined', `    at chargeCard (${join(root, 'src', 'payments', 'charge.ts')}:42:5)`])
      expect(unmapped).toEqual(['Error: card declined', `    at chargeCard (${generated}:3:9)`])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
