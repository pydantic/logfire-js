import { ROOT_CONTEXT } from '@opentelemetry/api'
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-web'
import { describe, expect, it } from 'vite-plus/test'

import { BrowserUrlSpanProcessor } from './BrowserUrlSpanProcessor'

describe('BrowserUrlSpanProcessor', () => {
  it('strips page and request secrets, including attributes added after span start', () => {
    const processor = new BrowserUrlSpanProcessor()
    const span = {
      attributes: { 'http.url': 'https://user:password@example.com/reset?token=secret#credential' },
      events: [],
      links: [],
    } as unknown as Span
    processor.onStart(span, ROOT_CONTEXT)
    expect(span.attributes).toEqual({ 'http.url': 'https://example.com/reset' })
    Object.assign(span.attributes, {
      'url.full': 'https://example.com/callback?code=secret#access_token=secret',
      'http.target': '/callback?code=secret#secret',
      'url.query': 'code=secret',
      'url.fragment': 'secret',
      'http.method': 'GET',
    })
    processor.onEnd(span)
    expect(span.attributes).toEqual({
      'http.url': 'https://example.com/reset',
      'url.full': 'https://example.com/callback',
      'http.target': '/callback',
      'http.method': 'GET',
    })
  })

  it.each([
    ['//user:password@example.com/reset?token=secret', 'https://example.com/reset'],
    ['https://user:password@/reset?token=secret', '[REDACTED]'],
    ['/reset?token=secret#fragment', '/reset'],
    ['reset?token=secret', '/reset'],
    ['https://logfire.invalid/reset?secret', 'https://logfire.invalid/reset'],
  ])('sanitizes URL %s', (input, expected) => {
    const span = { attributes: { 'http.url': input }, events: [], links: [] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'http.url': expected })
  })

  it('sanitizes resource timing event URLs and referrers', () => {
    const attributes = { 'http.url': 'https://example.com/asset?token=secret', 'http.referrer': 'https://example.com/?secret#fragment' }
    const span = { attributes: {}, events: [{ attributes }, {}], links: [] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(attributes).toEqual({ 'http.url': 'https://example.com/asset', 'http.referrer': 'https://example.com/' })
  })

  it('sanitizes every attribute whose key ends in .url, such as the Web Vitals LCP resource', () => {
    const span = {
      attributes: { 'web_vital.lcp.url': 'https://cdn.example.com/avatar.jpg?X-Amz-Signature=secret#frag', 'web_vital.lcp.element': 'img' },
      events: [],
      links: [],
    } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'web_vital.lcp.url': 'https://cdn.example.com/avatar.jpg', 'web_vital.lcp.element': 'img' })
  })

  it('removes queries and fragments from URLs in exception stack traces', () => {
    const stacktrace = [
      'Error: boom',
      '    at load (https://app.example.com/app.js?token=secret:10:5)',
      '    at https://user:pass@app.example.com/vendor.js?q=a)b#frag:3:1',
      'load@https://app.example.com/app.js?token=secret:10:5',
      '    at native (blob:https://app.example.com/0f3c:1:1)',
    ].join('\n')
    const attributes = { 'exception.stacktrace': stacktrace, 'exception.message': 'boom' }
    const span = { attributes: { 'exception.stacktrace': stacktrace }, events: [{ attributes }], links: [] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    const expected = [
      'Error: boom',
      '    at load (https://app.example.com/app.js:10:5)',
      '    at https://app.example.com/vendor.js:3:1',
      'load@https://app.example.com/app.js:10:5',
      '    at native (blob:https://app.example.com/0f3c:1:1)',
    ].join('\n')
    expect(span.attributes).toEqual({ 'exception.stacktrace': expected })
    expect(attributes).toEqual({ 'exception.stacktrace': expected, 'exception.message': 'boom' })
  })

  it('keeps only a full line and column pair after a URL in text', () => {
    const span = {
      attributes: {
        'exception.stacktrace':
          'Error: GET https://api.example.com/x?token=abc:123:456 failed\n    at f (https://app.example.com/a.js?v=9:12:34)',
      },
      events: [],
      links: [],
    } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({
      'exception.stacktrace': 'Error: GET https://api.example.com/x failed\n    at f (https://app.example.com/a.js:12:34)',
    })
  })

  it('sanitizes URL attributes on span links', () => {
    const attributes = { 'callback.url': 'https://app.example/reset?access_token=secret#frag', 'link.kind': 'follows' }
    const span = { attributes: {}, events: [], links: [{ attributes }, {}] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(attributes).toEqual({ 'callback.url': 'https://app.example/reset', 'link.kind': 'follows' })
  })

  it('removes a stack trace query that contains an apostrophe', () => {
    const span = {
      attributes: { 'exception.stacktrace': "Error: GET 'https://api.example.com/x?name=O'Reilly&token=secret' failed" },
      events: [],
      links: [],
    } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'exception.stacktrace': "Error: GET 'https://api.example.com/x' failed" })
  })

  it('handles a long run of closing punctuation in a stack trace in linear time', () => {
    const span = {
      attributes: { 'exception.stacktrace': `Error: https://example.test/?q=${')'.repeat(32_000)}x` },
      events: [],
      links: [],
    } as unknown as ReadableSpan
    const started = performance.now()
    new BrowserUrlSpanProcessor().onEnd(span)

    expect(span.attributes).toEqual({ 'exception.stacktrace': 'Error: https://example.test/' })
    // Generous bound: the unanchored punctuation regex took seconds for this input.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('does not export non-HTTP URL payloads or unexpected URL attribute types', () => {
    const span = {
      attributes: { 'url.full': 'data:text/plain,secret', 'http.url': ['secret'] },
      events: [],
      links: [],
    } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'url.full': '[REDACTED]' })
  })
})
