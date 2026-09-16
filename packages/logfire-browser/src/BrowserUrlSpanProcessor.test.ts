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
    processor.onEnd(span as ReadableSpan)
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

  it('does not export non-HTTP URL payloads or unexpected URL attribute types', () => {
    const span = { attributes: { 'url.full': 'data:text/plain,secret', 'http.url': ['secret'] }, events: [] } as unknown as ReadableSpan
    new BrowserUrlSpanProcessor().onEnd(span)
    expect(span.attributes).toEqual({ 'url.full': '[REDACTED]' })
  })
})
