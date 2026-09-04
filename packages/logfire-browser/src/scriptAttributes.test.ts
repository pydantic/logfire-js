import { describe, expect, it } from 'vite-plus/test'

import { MAX_SCRIPT_SOURCE_URL_CODE_POINTS, normalizeScriptSourceUrl } from './scriptAttributes'

describe('script attribute normalization', () => {
  it('removes credentials, queries, and fragments from HTTP URLs', () => {
    expect(normalizeScriptSourceUrl('https://user:token@cdn.example.com/app.js?account=secret#handler')).toBe(
      'https://cdn.example.com/app.js'
    )
  })

  it('uses stable placeholders for URLs that can contain payloads or per-load identifiers', () => {
    expect(normalizeScriptSourceUrl('data:text/javascript,alert(document.cookie)')).toBe('data:')
    expect(normalizeScriptSourceUrl('blob:https://example.com/550e8400-e29b-41d4-a716-446655440000')).toBe('blob:https://example.com')
    const scriptUrl = ['java', 'script:alert(document.cookie)'].join('')
    expect(normalizeScriptSourceUrl(scriptUrl)).toBe(['java', 'script:'].join(''))
  })

  it('bounds normalized HTTP URLs by Unicode code point', () => {
    const normalized = normalizeScriptSourceUrl(`https://example.com/${'😀'.repeat(MAX_SCRIPT_SOURCE_URL_CODE_POINTS)}`)

    expect(Array.from(normalized ?? '')).toHaveLength(MAX_SCRIPT_SOURCE_URL_CODE_POINTS)
    expect(normalized?.startsWith('https://example.com/')).toBe(true)
  })
})
