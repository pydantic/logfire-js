import { trace as TraceAPI } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { collectSpans } from './__test__/collectSpans'
import {
  DebugIdSpanProcessor,
  debugIdsAttributeForStack,
  debugIdsForStack,
  normalizeFrameUrl,
  parseStackFrameUrls,
  readInjectedRelease,
  stampSpanDebugIds,
} from './debugIds'
import { configureLogfireApi, reportError, span } from './index'

// Stands in for what the inject snippet writes when a bundle loads.
function setGlobal(name: '_debugIds' | '_logfireDebugIds' | '_logfireRelease', value: unknown): void {
  Reflect.set(globalThis, name, value)
}

const INDEX_URL = 'https://app.example.com/assets/index-a1b2.js'
const VENDOR_URL = 'https://app.example.com/assets/vendor-c3d4.js'
const LAZY_URL = 'https://app.example.com/assets/settings-e5f6.js'
const INDEX_ID = '6f1e2d3c-0000-4000-8000-00000000000a'
const VENDOR_ID = '6f1e2d3c-0000-4000-8000-00000000000b'
const LAZY_ID = '6f1e2d3c-0000-4000-8000-00000000000c'

// What the inject snippet captures with `new Error().stack` as the first statement of each bundle.
const chromeRegistryKey = (url: string) => `Error\n    at ${url}:1:34`
const firefoxRegistryKey = (url: string) => `@${url}:1:34\n`

const CHROME_STACK = [
  'TypeError: Cannot read properties of undefined (reading @https://evil.example/x.js:1:1)',
  `    at handleClick (${INDEX_URL}:10:15)`,
  `    at ${VENDOR_URL}:2:300`,
  '    at async Promise.all (index 0)',
  `    at eval (eval at <anonymous> (${LAZY_URL}:1:1), <anonymous>:1:1)`,
].join('\n')

const FIREFOX_STACK = [
  `handleClick@${INDEX_URL}:10:15`,
  `dispatch/<@${VENDOR_URL}:2:300`,
  `@${LAZY_URL} line 4 > eval:1:1`,
  `async*run@${INDEX_URL}:20:1`,
  '',
].join('\n')

const SAFARI_STACK = [`handleClick@${INDEX_URL}:10:15`, `global code@${VENDOR_URL}:2:300`, '[native code]'].join('\n')

afterEach(() => {
  Reflect.deleteProperty(globalThis, '_logfireDebugIds')
  Reflect.deleteProperty(globalThis, '_debugIds')
  Reflect.deleteProperty(globalThis, '_logfireRelease')
})

describe('parseStackFrameUrls', () => {
  test('reads V8 frames and skips the message, native and eval frames', () => {
    expect(parseStackFrameUrls(CHROME_STACK)).toEqual([INDEX_URL, VENDOR_URL])
  })

  test('reads SpiderMonkey frames and skips eval frames', () => {
    expect(parseStackFrameUrls(FIREFOX_STACK)).toEqual([INDEX_URL, VENDOR_URL, INDEX_URL])
  })

  test('reads JavaScriptCore frames', () => {
    expect(parseStackFrameUrls(SAFARI_STACK)).toEqual([INDEX_URL, VENDOR_URL])
  })

  test('reads Node CommonJS paths, ESM file URLs, internals, and Windows paths', () => {
    const stack = [
      'Error: failed',
      '    at Object.<anonymous> (/app/dist/server.js:3:9)',
      '    at file:///app/dist/server.mjs:4:1',
      '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
      '    at main (C:\\app\\dist\\server.js:3:9)',
      '    at new Handler (/app/dist/server.js:8:2)',
    ].join('\n')

    expect(parseStackFrameUrls(stack)).toEqual([
      '/app/dist/server.js',
      'file:///app/dist/server.mjs',
      'node:internal/modules/cjs/loader',
      'C:\\app\\dist\\server.js',
      '/app/dist/server.js',
    ])
  })

  test('reads Workers module names and URLs with a port', () => {
    // `script-0` is how workerd under Miniflare names an inline module.
    const stack = [
      'Error: failed',
      '    at Object.fetch (index.js:12:11)',
      '    at fail (script-0:3:25)',
      '    at http://localhost:8787/worker.js:1:2',
    ].join('\n')

    expect(parseStackFrameUrls(stack)).toEqual(['index.js', 'script-0', 'http://localhost:8787/worker.js'])
  })

  test('reads anonymous async frames', () => {
    const stack = [
      'Error: failed',
      '    at f (/app/dist/server.js:2:60)',
      '    at async /app/dist/server.js:2:94',
      `    at async ${INDEX_URL}:1:16`,
    ].join('\n')

    expect(parseStackFrameUrls(stack)).toEqual(['/app/dist/server.js', '/app/dist/server.js', INDEX_URL])
  })

  test('parses a crafted message line in linear time', () => {
    // A backtracking frame pattern took seconds on a 6.5 KB version of this; the test timeout catches a regression.
    const crafted = `    at ${' '.repeat(20_000)}f (/app/dist/server.js:1:1) ${'a ('.repeat(20_000)}z`
    const stack = ['Error: bad', crafted, `x@${'a@'.repeat(20_000)}:1:z`, '    at /app/dist/server.js:3:9'].join('\n')

    expect(parseStackFrameUrls(stack)).toEqual(['/app/dist/server.js'])
  })
})

describe('normalizeFrameUrl', () => {
  test('drops the query, fragment, and credentials', () => {
    expect(normalizeFrameUrl('https://user:secret@app.example.com/a.js?v=2#top')).toBe('https://app.example.com/a.js')
    expect(normalizeFrameUrl('/app/dist/server.js')).toBe('/app/dist/server.js')
  })
})

describe('debugIdsForStack', () => {
  test('returns undefined when no registry exists', () => {
    expect(debugIdsForStack(CHROME_STACK)).toBe(undefined)
  })

  test('returns the debug IDs of the injected bundles in the stack only', () => {
    setGlobal('_logfireDebugIds', {
      [chromeRegistryKey(INDEX_URL)]: INDEX_ID,
      [chromeRegistryKey(VENDOR_URL)]: VENDOR_ID,
      [chromeRegistryKey(LAZY_URL)]: LAZY_ID,
    })

    expect(debugIdsForStack(CHROME_STACK)).toEqual({ [INDEX_URL]: INDEX_ID, [VENDOR_URL]: VENDOR_ID })
    expect(debugIdsAttributeForStack(SAFARI_STACK)).toBe(`{"${INDEX_URL}":"${INDEX_ID}","${VENDOR_URL}":"${VENDOR_ID}"}`)
  })

  test('matches Firefox registry keys and ignores cache-busting queries on either side', () => {
    setGlobal('_logfireDebugIds', { [firefoxRegistryKey(`${INDEX_URL}?v=1`)]: INDEX_ID })

    expect(debugIdsForStack(`handleClick@${INDEX_URL}?v=2:10:15`)).toEqual({ [INDEX_URL]: INDEX_ID })
  })

  test('returns undefined when no frame belongs to an injected bundle', () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(LAZY_URL)]: LAZY_ID })

    expect(debugIdsForStack(CHROME_STACK)).toBe(undefined)
  })

  test('reads the vendor-neutral registry, and the Logfire registry wins on conflict', () => {
    setGlobal('_debugIds', { [chromeRegistryKey(INDEX_URL)]: 'neutral-index', [chromeRegistryKey(VENDOR_URL)]: VENDOR_ID })
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID })

    expect(debugIdsForStack(CHROME_STACK)).toEqual({ [INDEX_URL]: INDEX_ID, [VENDOR_URL]: VENDOR_ID })
  })

  test('picks up bundles registered after an earlier lookup', () => {
    const registry: Record<string, string> = { [chromeRegistryKey(INDEX_URL)]: INDEX_ID }
    setGlobal('_logfireDebugIds', registry)
    expect(debugIdsForStack(CHROME_STACK)).toEqual({ [INDEX_URL]: INDEX_ID })

    registry[chromeRegistryKey(VENDOR_URL)] = VENDOR_ID

    expect(debugIdsForStack(CHROME_STACK)).toEqual({ [INDEX_URL]: INDEX_ID, [VENDOR_URL]: VENDOR_ID })
  })

  test('ignores malformed registries and entries', () => {
    setGlobal('_debugIds', 'not a registry')
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: 42, 'no frames here': VENDOR_ID, [chromeRegistryKey(VENDOR_URL)]: '' })

    expect(debugIdsForStack(CHROME_STACK)).toBe(undefined)
  })

  test('returns undefined when reading the registry throws', () => {
    Object.defineProperty(globalThis, '_logfireDebugIds', {
      configurable: true,
      get() {
        throw new Error('hostile getter')
      },
    })

    expect(debugIdsForStack(CHROME_STACK)).toBe(undefined)
  })
})

describe('stampSpanDebugIds', () => {
  test('stamps exception events and the span, and keeps existing values', () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID, [chromeRegistryKey(VENDOR_URL)]: VENDOR_ID })
    const span = {
      attributes: {},
      events: [
        { attributes: { 'exception.stacktrace': `Error\n    at f (${INDEX_URL}:1:1)` }, name: 'exception', time: [0, 0] },
        { attributes: { 'exception.stacktrace': `Error\n    at g (${VENDOR_URL}:1:1)` }, name: 'not-an-exception', time: [0, 0] },
        {
          attributes: { 'exception.stacktrace': `Error\n    at g (${VENDOR_URL}:1:1)`, 'logfire.debug_ids': 'kept' },
          name: 'exception',
          time: [0, 0],
        },
      ],
    } as unknown as Pick<ReadableSpan, 'attributes' | 'events'>

    stampSpanDebugIds(span)

    expect(span.events.map((event) => event.attributes?.['logfire.debug_ids'])).toEqual([
      `{"${INDEX_URL}":"${INDEX_ID}"}`,
      undefined,
      'kept',
    ])
    expect(span.attributes['logfire.debug_ids']).toBe(`{"${INDEX_URL}":"${INDEX_ID}","${VENDOR_URL}":"${VENDOR_ID}"}`)
  })

  test('merges an existing span value with every exception event, keeping existing entries', () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID, [chromeRegistryKey(VENDOR_URL)]: VENDOR_ID })
    const span = {
      attributes: { 'logfire.debug_ids': `{"${VENDOR_URL}":"stamped-earlier"}` },
      events: [
        { attributes: { 'exception.stacktrace': `Error\n    at f (${INDEX_URL}:1:1)` }, name: 'exception', time: [0, 0] },
        { attributes: { 'exception.stacktrace': `Error\n    at g (${VENDOR_URL}:1:1)` }, name: 'exception', time: [0, 0] },
      ],
    } as unknown as Pick<ReadableSpan, 'attributes' | 'events'>

    stampSpanDebugIds(span)

    expect(span.attributes['logfire.debug_ids']).toBe(`{"${INDEX_URL}":"${INDEX_ID}","${VENDOR_URL}":"stamped-earlier"}`)
  })

  test('leaves an existing span value it cannot read', () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID })
    const span = {
      attributes: { 'logfire.debug_ids': '["not", "a map"]' },
      events: [{ attributes: { 'exception.stacktrace': `Error\n    at f (${INDEX_URL}:1:1)` }, name: 'exception', time: [0, 0] }],
    } as unknown as Pick<ReadableSpan, 'attributes' | 'events'>

    stampSpanDebugIds(span)

    expect(span.attributes['logfire.debug_ids']).toBe('["not", "a map"]')
  })

  test('changes nothing without a registry', () => {
    const span = {
      attributes: { 'exception.stacktrace': `Error\n    at f (${INDEX_URL}:1:1)` },
      events: [{ attributes: { 'exception.stacktrace': `Error\n    at f (${INDEX_URL}:1:1)` }, name: 'exception', time: [0, 0] }],
    } as unknown as Pick<ReadableSpan, 'attributes' | 'events'>
    const before = JSON.stringify(span)

    stampSpanDebugIds(span)

    expect(JSON.stringify(span)).toBe(before)
  })
})

describe('readInjectedRelease', () => {
  test('returns a non-empty release string only', () => {
    expect(readInjectedRelease()).toBe(undefined)
    setGlobal('_logfireRelease', '  ')
    expect(readInjectedRelease()).toBe(undefined)
    setGlobal('_logfireRelease', 42)
    expect(readInjectedRelease()).toBe(undefined)
    setGlobal('_logfireRelease', '9f3c2ab')
    expect(readInjectedRelease()).toBe('9f3c2ab')
  })
})

function errorWithStack(message: string, stack: string): Error {
  const error = new Error(message)
  error.stack = stack
  return error
}

describe('exported spans', () => {
  test('reportError() stamps the span and its exception event', async () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID })
    const expected = `{"${INDEX_URL}":"${INDEX_ID}"}`

    const spans = await collectSpans(
      (primary) => [new DebugIdSpanProcessor(), primary],
      () => {
        reportError('Checkout failed', errorWithStack('boom', CHROME_STACK))
      }
    )

    expect(spans.map((exported) => exported.attributes['logfire.debug_ids'])).toEqual([expected])
    expect(spans[0]?.events.map((event) => [event.name, event.attributes?.['logfire.debug_ids']])).toEqual([['exception', expected]])
  })

  test('reportError() stamps the span without the processor', async () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID })

    const spans = await collectSpans(
      (primary) => [primary],
      () => {
        reportError('Checkout failed', errorWithStack('boom', CHROME_STACK))
      }
    )

    expect(spans.map((exported) => exported.attributes['logfire.debug_ids'])).toEqual([`{"${INDEX_URL}":"${INDEX_ID}"}`])
  })

  test('a failing span() callback stamps the span and its exception event', async () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(VENDOR_URL)]: VENDOR_ID })
    const expected = `{"${VENDOR_URL}":"${VENDOR_ID}"}`

    const spans = await collectSpans(
      (primary) => [new DebugIdSpanProcessor(), primary],
      () => {
        expect(() =>
          span('checkout', {
            callback: () => {
              throw errorWithStack('boom', CHROME_STACK)
            },
          })
        ).toThrow('boom')
      }
    )

    expect(spans.map((exported) => exported.attributes['logfire.debug_ids'])).toEqual([expected])
    expect(spans[0]?.events.map((event) => event.attributes?.['logfire.debug_ids'])).toEqual([expected])
  })

  test('a span() callback that records one exception and throws another lists both bundles on the span', async () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID, [chromeRegistryKey(VENDOR_URL)]: VENDOR_ID })

    const spans = await collectSpans(
      (primary) => [new DebugIdSpanProcessor(), primary],
      () => {
        expect(() =>
          span('checkout', {
            callback: (active) => {
              active.recordException(errorWithStack('first', `Error: first\n    at f (${INDEX_URL}:1:1)`))
              throw errorWithStack('second', `Error: second\n    at g (${VENDOR_URL}:1:1)`)
            },
          })
        ).toThrow('second')
      }
    )

    expect(spans.map((exported) => exported.attributes['logfire.debug_ids'])).toEqual([
      `{"${INDEX_URL}":"${INDEX_ID}","${VENDOR_URL}":"${VENDOR_ID}"}`,
    ])
    expect(spans[0]?.events.map((event) => event.attributes?.['logfire.debug_ids'])).toEqual([
      `{"${INDEX_URL}":"${INDEX_ID}"}`,
      `{"${VENDOR_URL}":"${VENDOR_ID}"}`,
    ])
  })

  test('the processor stamps exceptions that instrumentations record directly', async () => {
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(INDEX_URL)]: INDEX_ID })
    const expected = `{"${INDEX_URL}":"${INDEX_ID}"}`

    const spans = await collectSpans(
      (primary) => [new DebugIdSpanProcessor(), primary],
      () => {
        const instrumented = TraceAPI.getTracer('instrumentation').startSpan('GET /checkout')
        instrumented.recordException(errorWithStack('boom', CHROME_STACK))
        instrumented.end()
      }
    )

    expect(spans.map((exported) => exported.attributes['logfire.debug_ids'])).toEqual([expected])
    expect(spans[0]?.events.map((event) => event.attributes?.['logfire.debug_ids'])).toEqual([expected])
  })

  test('without a registry the exported span has no debug ID attribute', async () => {
    const spans = await collectSpans(
      (primary) => [new DebugIdSpanProcessor(), primary],
      () => {
        reportError('Checkout failed', errorWithStack('boom', CHROME_STACK))
      }
    )

    expect(spans.map((exported) => Object.keys(exported.attributes).filter((key) => key.includes('debug')))).toEqual([[]])
    expect(spans[0]?.events.map((event) => Object.keys(event.attributes ?? {}).sort())).toEqual([
      ['exception.message', 'exception.stacktrace', 'exception.type'],
    ])
  })

  test('default scrubbing keeps a bundle URL that contains a sensitive word', async () => {
    const authUrl = 'https://app.example.com/assets/auth-session-Bx3k.js'
    setGlobal('_logfireDebugIds', { [chromeRegistryKey(authUrl)]: INDEX_ID })
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new DebugIdSpanProcessor(), new SimpleSpanProcessor(exporter)] })
    TraceAPI.setGlobalTracerProvider(provider)
    configureLogfireApi({ otelScope: 'logfire', scrubbing: {} })

    try {
      reportError('Login failed', errorWithStack('boom', `Error: boom\n    at login (${authUrl}:3:4)`))
      await provider.forceFlush()

      expect(exporter.getFinishedSpans().map((exported) => exported.attributes['logfire.debug_ids'])).toEqual([
        `{"${authUrl}":"${INDEX_ID}"}`,
      ])
    } finally {
      await provider.shutdown()
      TraceAPI.disable()
      configureLogfireApi({ scrubbing: false })
    }
  })
})
