import { describe, expect, it } from 'vite-plus/test'

import { matchesUrlPatterns, redactUrl } from './privacy'

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
