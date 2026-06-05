import { describe, expect, it } from 'vite-plus/test'

import { getBaseUrlFromToken } from '../tokenBaseUrl'
import { isCliRegion, resolveSelectedBaseUrl } from './regions'

describe('CLI regions', () => {
  it('accepts public regions and rejects inherited object properties', () => {
    expect(isCliRegion('us')).toBe(true)
    expect(isCliRegion('eu')).toBe(true)
    expect(isCliRegion('toString')).toBe(false)
    expect(isCliRegion('constructor')).toBe(false)
    expect(isCliRegion('mars')).toBe(false)
  })

  it('resolves base URLs from region ids and explicit URLs', () => {
    expect(resolveSelectedBaseUrl(undefined, 'us')).toBe('https://logfire-us.pydantic.dev')
    expect(resolveSelectedBaseUrl(undefined, 'eu')).toBe('https://logfire-eu.pydantic.dev')
    expect(resolveSelectedBaseUrl('https://self-hosted.example.com/', undefined)).toBe('https://self-hosted.example.com')
    expect(resolveSelectedBaseUrl(undefined, undefined)).toBeUndefined()
    expect(() => resolveSelectedBaseUrl(undefined, 'constructor')).toThrow('Unknown Logfire region')
  })

  it('falls back to US for tokens whose region matches an inherited property', () => {
    // `constructor` is lowercase letters, so it matches the token regex's region group;
    // an own-property check keeps it from resolving to Object.prototype.constructor.
    expect(getBaseUrlFromToken('pylf_v1_constructor_abc123')).toBe('https://logfire-us.pydantic.dev')
    expect(getBaseUrlFromToken('pylf_v1_eu_abc123')).toBe('https://logfire-eu.pydantic.dev')
    expect(getBaseUrlFromToken(undefined)).toBe('https://logfire-us.pydantic.dev')
  })
})
