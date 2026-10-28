import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { ATTRIBUTES_SCRUBBED_KEY } from './constants'
import { copyScrubbedAttributes, recordScrubbedAttributes, scrubLogRecordForExport, scrubSpanForExport } from './exportScrubbing'
import type { ScrubbableLogRecord } from './exportScrubbing'
import { configureLogfireApi } from './logfireApiConfig'
import { serializeAttributes } from './serializeAttributes'

function fakeSpan(fields: Partial<Pick<ReadableSpan, 'attributes' | 'events' | 'links'>>): ReadableSpan {
  return { attributes: {}, events: [], links: [], ...fields } as unknown as ReadableSpan
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

  test('leaves exception messages and stack traces unscrubbed, like the Python SDK', () => {
    const attributes = {
      'exception.message': 'invalid session token',
      'exception.stacktrace': 'Error: invalid session token\n    at login (https://app.example/auth.js:1:2)',
      'exception.type': 'Error',
    }
    const span = fakeSpan({ events: [{ attributes: { ...attributes }, name: 'exception', time: [0, 0] }] })

    scrubSpanForExport(span)

    expect(span.events[0]?.attributes).toEqual(attributes)
    expect(span.attributes).toEqual({})
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

  test('changes nothing when scrubbing is disabled', () => {
    configureLogfireApi({ scrubbing: false })
    const span = fakeSpan({ attributes: { 'app.password': 'hunter2' } })

    scrubSpanForExport(span)

    expect(span.attributes).toEqual({ 'app.password': 'hunter2' })
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
