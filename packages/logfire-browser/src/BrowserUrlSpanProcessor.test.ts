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
    const span = { attributes: { 'http.url': input }, events: [] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'http.url': expected })
  })

  it('sanitizes resource timing event URLs and referrers', () => {
    const attributes = { 'http.url': 'https://example.com/asset?token=secret', 'http.referrer': 'https://example.com/?secret#fragment' }
    const span = { attributes: {}, events: [{ attributes }, {}] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(attributes).toEqual({ 'http.url': 'https://example.com/asset', 'http.referrer': 'https://example.com/' })
  })

  it('sanitizes every attribute whose key ends in .url, such as the Web Vitals LCP resource', () => {
    const span = {
      attributes: { 'web_vital.lcp.url': 'https://cdn.example.com/avatar.jpg?X-Amz-Signature=secret#frag', 'web_vital.lcp.element': 'img' },
      events: [],
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
    const span = { attributes: { 'exception.stacktrace': stacktrace }, events: [{ attributes }] } as unknown as ReadableSpan
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
          'Error: GET https://api.example.com/x?token=abc:123456 failed\n    at f (https://app.example.com/a.js?v=9:12:34)',
      },
      events: [],
    } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({
      'exception.stacktrace': 'Error: GET https://api.example.com/x failed\n    at f (https://app.example.com/a.js:12:34)',
    })
  })

  it('does not export non-HTTP URL payloads or unexpected URL attribute types', () => {
    const span = { attributes: { 'url.full': 'data:text/plain,secret', 'http.url': ['secret'] }, events: [] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'url.full': '[REDACTED]' })
  })
})
