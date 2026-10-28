import { describe, expect, it } from 'vite-plus/test'

import { cutText, matchesUrlPatterns, redactCssUrls, redactSrcset, redactUrl, redactUrlsInText, truncateText } from './privacy'

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

  it('keeps only the scheme of opaque and blob URLs', () => {
    expect(redactUrl('mailto:jane@example.test?subject=hi', [/.+/u], baseUrl)).toBe('mailto:')
    expect(redactUrl('tel:+15550100', [/.+/u], baseUrl)).toBe('tel:')
    expect(redactUrl('data:image/png;base64,AAAA', [/.+/u], baseUrl)).toBe('data:')
    expect(redactUrl('blob:https://app.example.test/0f6e3c1a', [/.+/u], baseUrl)).toBe('blob:')
  })

  it('applies a transform after the built-in redaction', () => {
    const transform = (url: string) => url.replace(/\/reset\/[^/?#]+/u, '/reset/:token')

    expect(redactUrl('/reset/abc123?next=/home', [/.+/u], baseUrl, transform)).toBe('https://app.example.test/reset/:token')
    expect(redactUrl('/reset/abc123?next=/home', [], baseUrl, transform)).toBe('/reset/:token?next=/home')
  })

  it('keeps the built-in redaction when a transform throws or returns a non-string', () => {
    const throwing = () => {
      throw new Error('transform failed')
    }
    const nonString = (() => undefined) as unknown as (url: string) => string

    expect(redactUrl('/reset/abc123?token=secret', [/.+/u], baseUrl, throwing)).toBe('https://app.example.test/reset/abc123')
    expect(redactUrl('/reset/abc123?token=secret', [/.+/u], baseUrl, nonString)).toBe('https://app.example.test/reset/abc123')
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

    expect(redactUrlsInText(stack, [/.+/u], baseUrl, { stackTrace: true })).toBe(
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
    expect(
      redactUrlsInText('    at f (https://api.example.test/x.js?token=abc:123:456:10:5)', [/.+/u], baseUrl, { stackTrace: true })
    ).toBe('    at f (https://api.example.test/x.js:10:5)')
    expect(redactUrlsInText('at https://api.example.test/x?secret=123:456', [/.+/u], baseUrl)).toBe('at https://api.example.test/x')
    expect(redactUrlsInText('user@https://api.example.test/x?secret=123:456', [/.+/u], baseUrl)).toBe('user@https://api.example.test/x')
  })

  it('removes a query that contains an apostrophe and keeps quotes around a URL', () => {
    expect(redactUrlsInText("GET https://api.example.test/x?name=O'Reilly&token=secret failed", [/.+/u], baseUrl)).toBe(
      'GET https://api.example.test/x failed'
    )
    expect(redactUrlsInText("see 'https://api.example.test/x?token=secret' (or https://api.example.test/y?k=1)", [/.+/u], baseUrl)).toBe(
      "see 'https://api.example.test/x' (or https://api.example.test/y)"
    )
  })

  it('handles a long run of closing punctuation in linear time', () => {
    const text = `https://example.test/?q=${')'.repeat(32_000)}x`
    const started = performance.now()

    expect(redactUrlsInText(text, [/.+/u], baseUrl)).toBe('https://example.test/')
    // Generous bound: the unanchored punctuation regex took seconds for this input.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('tests each URL embedded in a match against the patterns', () => {
    const privateOnly = [/^https:\/\/private\./u]

    expect(
      redactUrlsInText('go https://public.example.test/login?next=https://private.example.test/x?token=secret', privateOnly, baseUrl)
    ).toBe('go https://public.example.test/login')
    expect(redactUrlsInText('go https://public.example.test/login?next=/home', privateOnly, baseUrl)).toBe(
      'go https://public.example.test/login?next=/home'
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

    expect(redactUrlsInText(text, [/cdn\./u], baseUrl, { stackTrace: true })).toBe(
      'at https://app.example.test/a.js?t=1:1:1 and https://cdn.example.test/b.js:2:2'
    )
    expect(redactUrlsInText(text, [], baseUrl)).toBe(text)
  })
})

describe('redactSrcset', () => {
  const redact = (url: string) => redactUrl(url, [/.+/u], baseUrl)

  it('redacts each candidate URL and keeps descriptors and separators', () => {
    expect(redactSrcset('/a.png?t=1 1x, /b.png?t=2 2x', redact)).toBe(
      'https://app.example.test/a.png 1x, https://app.example.test/b.png 2x'
    )
    expect(redactSrcset('/a.png?t=1 480w,/b.png?t=2 800w', redact)).toBe(
      'https://app.example.test/a.png 480w,https://app.example.test/b.png 800w'
    )
  })

  it('ends a candidate at trailing commas of a URL without descriptors', () => {
    expect(redactSrcset('/a.png?t=1, /b.png?t=2', redact)).toBe('https://app.example.test/a.png, https://app.example.test/b.png')
  })

  it('keeps a comma inside a URL as part of that URL', () => {
    expect(redactSrcset('data:image/png;base64,AAAA 1x', redact)).toBe('data: 1x')
  })
})

describe('redactCssUrls', () => {
  const redact = (url: string) => redactUrl(url, [/.+/u], baseUrl)

  it('redacts quoted and unquoted url() values', () => {
    expect(redactCssUrls('background: url("/bg.png?t=1") no-repeat; mask: URL(/m.svg?t=2)', redact)).toBe(
      'background: url("https://app.example.test/bg.png") no-repeat; mask: url(https://app.example.test/m.svg)'
    )
    expect(redactCssUrls("background-image: url( '/a.png?t=1' )", redact)).toBe("background-image: url('https://app.example.test/a.png')")
  })

  it('leaves CSS without url() unchanged', () => {
    expect(redactCssUrls('color: red', redact)).toBe('color: red')
  })

  it('reads escaped characters as part of the URL', () => {
    expect(redactCssUrls('background: url(/image\\)?token=secret)', redact)).toBe('background: url(https://app.example.test/image\\))')
    expect(redactCssUrls('background: url("/a\\"b.png?token=secret")', redact)).toBe(
      'background: url("https://app.example.test/a%22b.png")'
    )
    expect(redactCssUrls('background: url(/\\3f token=secret)', redact)).toBe('background: url(https://app.example.test/)')
  })

  it('recognizes url functions whose names are written with escapes', () => {
    expect(redactCssUrls('background: u\\72l(/image?token=secret)', redact)).toBe('background: url(https://app.example.test/image)')
    expect(redactCssUrls('background: \\55 RL(/image?token=secret)', redact)).toBe('background: url(https://app.example.test/image)')
    expect(redactCssUrls('background: xurl(/image?token=secret)', redact)).toBe('background: xurl(/image?token=secret)')
  })

  it('keeps an escaped trailing space in an unquoted URL', () => {
    const seen: string[] = []
    redactCssUrls('background: url(/a\\  )', (url) => {
      seen.push(url)
      return url
    })
    expect(seen).toEqual(['/a '])
  })

  it('keeps offsets when earlier text changes length when lowercased', () => {
    expect(redactCssUrls('content: "İ"; background: url(/image.png?token=secret)', redact)).toBe(
      'content: "İ"; background: url(https://app.example.test/image.png)'
    )
  })

  it('redacts a URL that the end of the text closes', () => {
    expect(redactCssUrls('background: url(/a.png?token=secret', redact)).toBe('background: url(https://app.example.test/a.png')
    expect(redactCssUrls("background: url('/a.png?token=secret", redact)).toBe("background: url('https://app.example.test/a.png'")
  })

  it('scans text with an unclosed url( in linear time', () => {
    const value = `--label: "url(${' '.repeat(100_000)}"; ${'url('.repeat(100_000)}`
    const started = performance.now()
    redactCssUrls(value, redact)
    // Generous bound: the backtracking pattern took seconds for 1,600 spaces.
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('truncateText', () => {
  it('keeps text within the limit', () => {
    expect(truncateText('short', 10)).toBe('short')
    expect(cutText('short', 10)).toEqual(['short', 0])
  })

  it('cuts longer text and reports the dropped length', () => {
    expect(truncateText('abcdefghij', 4)).toBe('abcd...(+6 chars)')
  })

  it('does not split a surrogate pair', () => {
    expect(cutText('abc\u{1F600}def', 4)).toEqual(['abc', 5])
  })
})
