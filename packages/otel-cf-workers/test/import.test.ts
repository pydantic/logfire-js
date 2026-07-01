import { expect, it, vitest } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

import * as packageRoot from '@pydantic/otel-cf-workers'
import * as otelCfWorkers from '../src/index'
import { instrument } from '../src/index'

it('can import in esm', () => {
  expect(otelCfWorkers).toBeDefined()
  expect(otelCfWorkers.instrument).toBeTypeOf('function')

  expect(instrument).toBeDefined()
  expect(instrument).toBeTypeOf('function')
})

it('exposes expected package-root esm exports', () => {
  for (const exportName of [
    'instrument',
    'instrumentDO',
    'waitUntilTrace',
    '__unwrappedFetch',
    'withNextSpan',
    'OTLPExporter',
    'BatchTraceSpanProcessor',
    'MultiSpanExporter',
    'MultiSpanExporterAsync',
  ]) {
    expect(packageRoot).toHaveProperty(exportName)
  }
})

it('publishes esm-only package metadata', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, Record<string, string>>
  }

  expect(packageJson.exports['.']).not.toHaveProperty('require')
  expect(packageJson.exports['.']?.default).toBe('./dist/index.js')
  expect(packageJson.exports['.']?.types).toBe('./dist/index.d.ts')
  expect(readdirSync(new URL('../dist', import.meta.url)).sort()).toEqual(['index.d.ts', 'index.js'])
})

it('keeps the Buffer polyfill as an entrypoint side effect', async () => {
  const globals = globalThis as unknown as { Buffer?: typeof Buffer }
  const originalBuffer = globals.Buffer

  vitest.resetModules()
  Reflect.deleteProperty(globals, 'Buffer')

  try {
    await import('../src/index')
    expect(globals.Buffer).toBe(Buffer)
  } finally {
    if (originalBuffer === undefined) {
      Reflect.deleteProperty(globals, 'Buffer')
    } else {
      globals.Buffer = originalBuffer
    }
  }

  expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).toContain("import './buffer.js'")
})
