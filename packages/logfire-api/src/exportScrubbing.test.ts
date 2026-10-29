import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { ATTRIBUTES_SCRUBBED_KEY } from './constants'
import {
  copyScrubbedAttributes,
  recordScrubbedAttributes,
  scrubbedSpanCopy,
  scrubLogRecordForExport,
  scrubSpanForExport,
} from './exportScrubbing'
import type { ScrubbableLogRecord } from './exportScrubbing'
import { logfireFormatWithExtras } from './formatter'
import { configureLogfireApi, logfireApiConfig } from './logfireApiConfig'
import { serializeAttributes } from './serializeAttributes'

function fakeSpan(fields: Partial<Pick<ReadableSpan, 'attributes' | 'events' | 'links'>>): ReadableSpan {
  return { attributes: {}, events: [], links: [], status: { code: 0 }, ...fields } as unknown as ReadableSpan
}

function fakeLogRecord(attributes: Record<string, unknown>, body?: unknown): ScrubbableLogRecord {
  const record = {
    attributes: { ...attributes },
    body,
    setAttribute(key: string, value?: unknown) {
      record.attributes[key] = value
      return record
    },
    setBody(next: unknown) {
      record.body = next
      return record
    },
  }
  return record
}

describe('scrubSpanForExport', () => {
  beforeEach(() => {
    configureLogfireApi({ scrubbing: {} })
  })

  test('scrubs attributes, event attributes, and link attributes that skipped the logfire API', () => {
    const span = fakeSpan({
      attributes: { 'app.password': 'hunter2', 'http.method': 'GET', retries: 3 },
      events: [{ attributes: { note: 'my api_key is abc' }, name: 'event', time: [0, 0] }],
      links: [{ attributes: { 'auth.header': 'Bearer abc' }, context: { spanId: '', traceFlags: 0, traceId: '' } }],
    })

    scrubSpanForExport(span)

    expect(span.attributes).toEqual({
      'app.password': "[Scrubbed due to 'password']",
      'http.method': 'GET',
      retries: 3,
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([
        { matched_substring: 'password', path: ['attributes', 'app.password'] },
        { matched_substring: 'api_key', path: ['otel_events', 0, 'attributes', 'note'] },
        { matched_substring: 'auth', path: ['links', 0, 'attributes', 'auth.header'] },
      ]),
    })
    expect(span.events[0]?.attributes).toEqual({ note: "[Scrubbed due to 'api_key']" })
    expect(span.links[0]?.attributes).toEqual({ 'auth.header': "[Scrubbed due to 'auth']" })
  })

  test('scrubs each string in an array attribute', () => {
    const span = fakeSpan({ attributes: { values: ['plain', 'session=abc'] } })

    scrubSpanForExport(span)

    expect(span.attributes['values']).toEqual(['plain', "[Scrubbed due to 'session']"])
  })

  test('scrubs the exception message, the message lines of its stack trace, and the status message', () => {
    const span = fakeSpan({
      events: [
        {
          attributes: {
            'exception.message': 'invalid session token',
            'exception.stacktrace': [
              'Error: invalid session token',
              '    at login (https://app.example/auth.js:1:2)',
              'login@https://app.example/auth.js:1:2',
              'Caused by: Error: bad password',
            ].join('\n'),
            'exception.type': 'Error',
          },
          name: 'exception',
          time: [0, 0],
        },
      ],
    })
    Object.assign(span, { status: { code: 2, message: 'Error: invalid session token' } })

    scrubSpanForExport(span)

    expect(span.events[0]?.attributes).toEqual({
      'exception.message': "[Scrubbed due to 'session']",
      'exception.stacktrace': [
        "[Scrubbed due to 'session']",
        '    at login (https://app.example/auth.js:1:2)',
        'login@https://app.example/auth.js:1:2',
        "[Scrubbed due to 'password']",
      ].join('\n'),
      'exception.type': 'Error',
    })
    expect(span.status).toEqual({ code: 2, message: "[Scrubbed due to 'session']" })
    expect(span.attributes).toEqual({
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([
        { matched_substring: 'session', path: ['otel_events', 0, 'attributes', 'exception.message'] },
        { matched_substring: 'session', path: ['otel_events', 0, 'attributes', 'exception.stacktrace'] },
        { matched_substring: 'password', path: ['otel_events', 0, 'attributes', 'exception.stacktrace'] },
        { matched_substring: 'session', path: ['otel_status_message'] },
      ]),
    })
  })

  test('skips keys that the runtime marks as safe', () => {
    const span = fakeSpan({ attributes: { 'session.id': 'abc', 'user.session': 'kept?' } })

    scrubSpanForExport(span, { isSafeKey: (key) => key === 'session.id' })

    expect(span.attributes).toEqual({
      'session.id': 'abc',
      'user.session': "[Scrubbed due to 'session']",
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([{ matched_substring: 'session', path: ['attributes', 'user.session'] }]),
    })
  })

  test('keeps only lines with a full stack-frame shape', () => {
    const stack = [
      'Error: Authentication failed for user@example.com:10:5',
      '    at password reset for jane',
      '    at login (https://app.example/auth.js:1:2)',
      '    at https://app.example/auth.js:3:4',
      '    at Array.forEach (<anonymous>)',
      '    at JSON.parse (native)',
      'login@https://app.example/auth.js:1:2',
      'global code@blob:https://app.example/0f3c:5:6',
      'Caused by: Error: session lost',
    ].join('\n')
    const span = fakeSpan({ attributes: { 'exception.stacktrace': stack } })

    scrubSpanForExport(span)

    expect(span.attributes['exception.stacktrace']).toBe(
      [
        "[Scrubbed due to 'Auth']",
        "[Scrubbed due to 'password']",
        '    at login (https://app.example/auth.js:1:2)',
        '    at https://app.example/auth.js:3:4',
        '    at Array.forEach (<anonymous>)',
        '    at JSON.parse (native)',
        'login@https://app.example/auth.js:1:2',
        'global code@blob:https://app.example/0f3c:5:6',
        "[Scrubbed due to 'session']",
      ].join('\n')
    )
  })

  test('applies safe keys and namespace prefixes to span attributes only, not events or links', () => {
    const span = fakeSpan({
      events: [{ attributes: { 'session.id': 'secret-1', 'logfire.session.tier': 'paid' }, name: 'event', time: [0, 0] }],
      links: [{ attributes: { 'session.id': 'secret-2' }, context: { spanId: '', traceFlags: 0, traceId: '' } }],
    })

    scrubSpanForExport(span, { isSafeKey: (key) => key === 'session.id', namespacePrefixes: ['logfire.session.'] })

    expect(span.events[0]?.attributes).toEqual({
      'session.id': "[Scrubbed due to 'session']",
      'logfire.session.tier': "[Scrubbed due to 'session']",
    })
    expect(span.links[0]?.attributes).toEqual({ 'session.id': "[Scrubbed due to 'session']" })
  })

  test('does not rescrub values the logfire API scrubbed at creation and appends new notes', () => {
    const created = serializeAttributes({ nested: { password: 'hunter2' }, token: 'plain' })
    const span = fakeSpan({ attributes: { ...created, 'late.secret': 'abc' } })
    recordScrubbedAttributes(span, created)

    scrubSpanForExport(span)

    expect(span.attributes).toEqual({
      ...created,
      'late.secret': "[Scrubbed due to 'secret']",
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([
        { matched_substring: 'password', path: ['nested', 'password'] },
        { matched_substring: 'secret', path: ['attributes', 'late.secret'] },
      ]),
    })
  })

  test('runs a scrubbing callback once per value and still scrubs values changed after creation', () => {
    const paths: unknown[] = []
    configureLogfireApi({
      scrubbing: {
        callback: (match) => {
          paths.push(match.path)
          return match.path.at(-1) === 'allowed_password' ? match.value : null
        },
      },
    })
    const created = serializeAttributes({ allowed_password: 'kept', changed_password: 'first' })
    const span = fakeSpan({ attributes: { ...created } })
    recordScrubbedAttributes(span, created)
    span.attributes['changed_password'] = 'second'

    scrubSpanForExport(span)

    expect(paths).toEqual([['allowed_password'], ['changed_password'], ['attributes', 'changed_password']])
    expect(span.attributes['allowed_password']).toBe('kept')
    expect(span.attributes['changed_password']).toBe("[Scrubbed due to 'password']")
  })

  test('scrubs text that imitates a scrubbed value', () => {
    const forged = "[Scrubbed due to ' password=hunter2 ']"
    const span = fakeSpan({ attributes: { note: forged } })

    expect(serializeAttributes({ note: forged })['note']).toBe("[Scrubbed due to 'password']")
    scrubSpanForExport(span)
    expect(span.attributes['note']).toBe("[Scrubbed due to 'password']")
  })

  test('carries the scrubbed-value record over to a copied attribute record', () => {
    const paths: unknown[] = []
    configureLogfireApi({
      scrubbing: {
        callback: (match) => {
          paths.push(match.path)
          return match.value
        },
      },
    })
    const created = serializeAttributes({ password: 'allowed' })
    const span = fakeSpan({ attributes: { ...created } })
    recordScrubbedAttributes(span, created)
    const copy = fakeSpan({ attributes: { ...span.attributes, 'logfire.span_type': 'pending_span' } })
    copyScrubbedAttributes(span.attributes, copy.attributes)

    scrubSpanForExport(copy)

    expect(paths).toEqual([['password']])
    expect(copy.attributes['password']).toBe('allowed')
  })

  test('skips values the caller passes as already scrubbed only while they are unchanged', () => {
    const span = fakeSpan({ attributes: { 'app.password': 'scrubbed elsewhere', 'other.password': 'raw' } })

    scrubSpanForExport(span, { alreadyScrubbed: { 'app.password': 'scrubbed elsewhere', 'other.password': 'different' } })

    expect(span.attributes['app.password']).toBe('scrubbed elsewhere')
    expect(span.attributes['other.password']).toBe("[Scrubbed due to 'password']")
  })

  test('matches only the application-chosen name under a namespace prefix', () => {
    const span = fakeSpan({
      attributes: { 'logfire.session.tier': 'paid', 'logfire.session.password': 'hunter2', 'logfire.session.plan': 'api_key=abc' },
    })

    scrubSpanForExport(span, { namespacePrefixes: ['logfire.session.'] })

    expect(span.attributes).toEqual({
      'logfire.session.tier': 'paid',
      'logfire.session.password': "[Scrubbed due to 'password']",
      'logfire.session.plan': "[Scrubbed due to 'api_key']",
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([
        { matched_substring: 'password', path: ['attributes', 'logfire.session', 'password'] },
        { matched_substring: 'api_key', path: ['attributes', 'logfire.session', 'plan'] },
      ]),
    })
  })

  test('replaces a value whose scrubbing callback throws instead of exporting it', () => {
    configureLogfireApi({
      scrubbing: {
        callback: () => {
          throw new Error('callback failed')
        },
      },
    })
    const span = fakeSpan({ attributes: { 'app.password': 'hunter2', 'http.method': 'GET' } })

    expect(() => {
      scrubSpanForExport(span)
    }).not.toThrow()
    expect(span.attributes).toEqual({ 'app.password': '[Scrubbing failed]', 'http.method': 'GET' })
  })

  test('returns a scrubbed copy that keeps the span methods and leaves the span unchanged', () => {
    const span = {
      attributes: { 'app.password': 'hunter2' },
      events: [{ attributes: { note: 'session=abc' }, name: 'event', time: [0, 0] }],
      links: [],
      spanContext: () => ({ spanId: 'span-1', traceFlags: 0, traceId: 'trace-1' }),
    } as unknown as ReadableSpan

    const copy = scrubbedSpanCopy(span)

    expect(copy.attributes['app.password']).toBe("[Scrubbed due to 'password']")
    expect(copy.events[0]?.attributes).toEqual({ note: "[Scrubbed due to 'session']" })
    expect(copy.spanContext().spanId).toBe('span-1')
    expect(span.attributes).toEqual({ 'app.password': 'hunter2' })
    expect(span.events[0]?.attributes).toEqual({ note: 'session=abc' })
  })

  test('changes nothing when scrubbing is disabled', () => {
    configureLogfireApi({ scrubbing: false })
    const span = fakeSpan({ attributes: { 'app.password': 'hunter2' } })

    scrubSpanForExport(span)

    expect(span.attributes).toEqual({ 'app.password': 'hunter2' })
  })
})

describe('scrubbing.safeKeys', () => {
  beforeEach(() => {
    configureLogfireApi({ scrubbing: { safeKeyPrefixes: ['app.checkout.'], safeKeys: ['app.result'] } })
  })

  test('keeps declared keys verbatim on a span from the raw OpenTelemetry tracer', async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    const span = provider.getTracer('app').startSpan('checkout', {
      attributes: { 'app.result': 'success_authenticated', 'app.label': 'session_restored' },
    })
    span.setAttribute('app.checkout.step', 'bootstrap_auth_dependency')
    span.end()
    await provider.forceFlush()
    const [finished] = exporter.getFinishedSpans()
    if (finished === undefined) {
      throw new Error('expected a finished span')
    }

    scrubSpanForExport(finished)

    expect(finished.attributes).toEqual({
      'app.result': 'success_authenticated',
      'app.label': "[Scrubbed due to 'session']",
      'app.checkout.step': 'bootstrap_auth_dependency',
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([{ matched_substring: 'session', path: ['attributes', 'app.label'] }]),
    })
    await provider.shutdown()
  })

  test('applies to event, link, and log record attributes but not the status message or log body', () => {
    const span = fakeSpan({
      events: [{ attributes: { 'app.result': 'auth_ok', 'app.label': 'auth_ok' }, name: 'event', time: [0, 0] }],
      links: [{ attributes: { 'app.checkout.step': 'auth_ok' }, context: { spanId: '', traceFlags: 0, traceId: '' } }],
    })
    span.status.message = 'auth_ok'

    scrubSpanForExport(span)

    expect(span.events[0]?.attributes).toEqual({ 'app.result': 'auth_ok', 'app.label': "[Scrubbed due to 'auth']" })
    expect(span.links[0]?.attributes).toEqual({ 'app.checkout.step': 'auth_ok' })
    expect(span.status.message).toBe("[Scrubbed due to 'auth']")

    const record = fakeLogRecord({ 'app.result': 'auth_ok' }, 'auth_ok')
    scrubLogRecordForExport(record)
    expect(record.attributes).toEqual({
      'app.result': 'auth_ok',
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([{ matched_substring: 'auth', path: ['log_body'] }]),
    })
  })

  test('exempts only top-level keys from the API helpers, including message template fields', () => {
    expect(serializeAttributes({ 'app.result': 'auth_ok', details: { 'app.result': 'auth_ok' } })).toEqual({
      'app.result': 'auth_ok',
      details: JSON.stringify({ 'app.result': "[Scrubbed due to 'auth']" }),
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([{ matched_substring: 'auth', path: ['details', 'app.result'] }]),
      'logfire.json_schema': JSON.stringify({
        properties: {
          details: { properties: { 'app.result': { type: 'string' } }, type: 'object' },
          [ATTRIBUTES_SCRUBBED_KEY]: {
            items: {
              properties: { matched_substring: { type: 'string' }, path: { items: { type: 'string' }, type: 'array' } },
              type: 'object',
            },
            type: 'array',
          },
        },
        type: 'object',
      }),
    })

    const { formattedMessage } = logfireFormatWithExtras(
      'checkout {app.result} {app.label}',
      { 'app.label': 'auth_ok', 'app.result': 'auth_ok' },
      logfireApiConfig.scrubber
    )
    expect(formattedMessage).toBe("checkout auth_ok [Scrubbed due to 'auth']")
  })

  test('skips the callback and extra patterns for declared keys only', () => {
    const callback = vi.fn<() => undefined>(() => undefined)
    configureLogfireApi({ scrubbing: { callback, extraPatterns: ['journey'], safeKeys: ['app.result'] } })
    const span = fakeSpan({ attributes: { 'app.result': 'journey_auth', 'app.label': 'journey_start' } })

    scrubSpanForExport(span)

    expect(span.attributes).toEqual({
      'app.result': 'journey_auth',
      'app.label': "[Scrubbed due to 'journey']",
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([{ matched_substring: 'journey', path: ['attributes', 'app.label'] }]),
    })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  test('rejects an empty prefix, which would exempt every key', () => {
    expect(() => {
      configureLogfireApi({ scrubbing: { safeKeyPrefixes: [''] } })
    }).toThrow('logfire: scrubbing.safeKeyPrefixes must not contain an empty string')
  })
})

describe('scrubLogRecordForExport', () => {
  beforeEach(() => {
    configureLogfireApi({ scrubbing: {} })
  })

  test('scrubs nested attributes and the body', () => {
    const record = fakeLogRecord({ request: { cookie: 'abc', path: '/x' }, level: 3 }, 'login with password hunter2')
    const setAttribute = vi.spyOn(record, 'setAttribute')

    scrubLogRecordForExport(record)

    expect(record.attributes).toEqual({
      request: { cookie: "[Scrubbed due to 'cookie']", path: '/x' },
      level: 3,
      [ATTRIBUTES_SCRUBBED_KEY]: JSON.stringify([
        { matched_substring: 'cookie', path: ['attributes', 'request', 'cookie'] },
        { matched_substring: 'password', path: ['log_body'] },
      ]),
    })
    expect(record.body).toBe("[Scrubbed due to 'password']")
    expect(setAttribute).not.toHaveBeenCalledWith('level', expect.anything())
  })

  test('keeps byte array bodies and attributes as bytes', () => {
    const bytes = new Uint8Array([1, 2])
    const record = fakeLogRecord({ payload: bytes }, bytes)
    const setAttribute = vi.spyOn(record, 'setAttribute')
    const setBody = vi.spyOn(record, 'setBody')

    scrubLogRecordForExport(record)

    expect(setAttribute).not.toHaveBeenCalled()
    expect(setBody).not.toHaveBeenCalled()
    expect(record.body).toBe(bytes)
  })

  test('leaves a clean record untouched', () => {
    const record = fakeLogRecord({ path: '/x' }, 'hello')
    const setAttribute = vi.spyOn(record, 'setAttribute')
    const setBody = vi.spyOn(record, 'setBody')

    scrubLogRecordForExport(record)

    expect(setAttribute).not.toHaveBeenCalled()
    expect(setBody).not.toHaveBeenCalled()
  })
})
