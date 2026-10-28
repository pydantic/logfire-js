import { describe, expect, it } from 'vite-plus/test'

import { matchesUrlPatterns, redactUrl, redactUrlsInText } from './privacy'

const baseUrl = 'https://app.example.test/current/page'

describe('redactUrl', () => {
  it('leaves URLs unchanged when no pattern matches', () => {
    expect(redactUrl('/orders?token=secret#details', [], baseUrl)).toBe('/orders?token=secret#details')
    expect(redactUrl('/orders?token=secret#details', [/other/u], baseUrl)).toBe('/orders?token=secret#details')
  })

  it('strips query strings and fragments from absolute and relative URLs', () => {
    expect(redactUrl('https://api.example.test/orders?token=secret#details', [/.+/u], baseUrl)).toBe('https://api.example.test/orders')
    expect(redactUrl('/orders?token=secret#details', [/.+/u], baseUrl)).toBe('https://app.example.test/orders')
  })

  it('falls back to string stripping for malformed URLs', () => {
    expect(redactUrl('https://[invalid]?token=secret#details', [/.+/u], baseUrl)).toBe('https://[invalid]')
  })

  it('does not mutate global or sticky pattern state across repeated matches', () => {
    const global = /token=/gu
    const sticky = /https:/uy
    global.lastIndex = 3
    sticky.lastIndex = 2

    expect(redactUrl('https://example.test/?token=one#first', [global], baseUrl)).toBe('https://example.test/')
    expect(redactUrl('https://example.test/?token=two#second', [global], baseUrl)).toBe('https://example.test/')
    expect(matchesUrlPatterns('https://example.test/?token=three', [sticky])).toBe(true)
    expect(global.lastIndex).toBe(3)
    expect(sticky.lastIndex).toBe(2)
  })
})

describe('redactUrlsInText', () => {
  it('redacts matching URLs inside stack frames and keeps line and column numbers', () => {
    const stack = [
      'Error: boom',
      '    at load (https://app.example.test/app.js?token=secret:10:5)',
      'load@https://app.example.test/app.js?token=secret#frag:10:5',
      '    at https://cdn.example.test/lib.js?q=a)b:3:1',
    ].join('\n')

    expect(redactUrlsInText(stack, [/.+/u], baseUrl)).toBe(
      [
        'Error: boom',
        '    at load (https://app.example.test/app.js:10:5)',
        'load@https://app.example.test/app.js:10:5',
        '    at https://cdn.example.test/lib.js:3:1',
      ].join('\n')
    )
  })

  it('does not restore digits that end a query value', () => {
    expect(redactUrlsInText('fetch https://api.example.test/x?token=abc:123456 failed', [/.+/u], baseUrl)).toBe(
      'fetch https://api.example.test/x failed'
    )
    expect(redactUrlsInText('fetch https://api.example.test/x?token=abc:123:456 failed', [/.+/u], baseUrl)).toBe(
      'fetch https://api.example.test/x failed'
    )
    expect(redactUrlsInText('    at f (https://api.example.test/x.js?token=abc:123:456:10:5)', [/.+/u], baseUrl)).toBe(
      '    at f (https://api.example.test/x.js:10:5)'
    )
  })

  it('redacts many URLs on one line in linear time', () => {
    const line = Array.from({ length: 10_000 }, (_, index) => `https://x.example.test/${index.toString()}?t=1`).join(' ')
    const started = performance.now()
    const redacted = redactUrlsInText(line, [/.+/u], baseUrl)

    expect(redacted).toBe(Array.from({ length: 10_000 }, (_, index) => `https://x.example.test/${index.toString()}`).join(' '))
    // Generous bound: the quadratic scan took seconds for this input.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('only redacts URLs that match a pattern', () => {
    const text = 'at https://app.example.test/a.js?t=1:1:1 and https://cdn.example.test/b.js?t=2:2:2'

    expect(redactUrlsInText(text, [/cdn\./u], baseUrl)).toBe(
      'at https://app.example.test/a.js?t=1:1:1 and https://cdn.example.test/b.js:2:2'
    )
    expect(redactUrlsInText(text, [], baseUrl)).toBe(text)
  })
})
