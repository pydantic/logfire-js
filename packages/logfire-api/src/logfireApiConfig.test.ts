import { expect, test } from 'vite-plus/test'

import { resolveBaseUrl } from './logfireApiConfig'

test('returns the passed url', () => {
  const baseUrl = resolveBaseUrl({}, 'https://example.com', 'token')
  expect(baseUrl).toBe('https://example.com')
})

test('trims the passed url', () => {
  const baseUrl = resolveBaseUrl({}, 'https://example.com/', 'token')
  expect(baseUrl).toBe('https://example.com')
})

test('resolves the US base url from the token', () => {
  const baseUrl = resolveBaseUrl({}, undefined, 'pylf_v1_us_1234567890')
  expect(baseUrl).toBe('https://logfire-us.pydantic.dev')
})

test('resolves the EU base url from the token', () => {
  const baseUrl = resolveBaseUrl({}, undefined, 'pylf_v1_eu_mFMvBQ7BWLPJ0fHYBGLVBmJ70TpkhlskgRLng0jFsb3n')
  expect(baseUrl).toBe('https://logfire-eu.pydantic.dev')
})

test('resolves the base url from API keys with organization IDs', () => {
  const baseUrl = resolveBaseUrl(
    {},
    undefined,
    'pylf_v1_eu_12345678-1234-1234-1234-123456789abc_mFMvBQ7BWLPJ0fHYBGLVBmJ70TpkhlskgRLng0jFsb3n'
  )
  expect(baseUrl).toBe('https://logfire-eu.pydantic.dev')
})

test('resolves staging base urls from the token', () => {
  expect(resolveBaseUrl({}, undefined, 'pylf_v1_stagingus_1234567890')).toBe('https://logfire-us.pydantic.info')
  expect(resolveBaseUrl({}, undefined, 'pylf_v1_stagingeu_1234567890')).toBe('https://logfire-eu.pydantic.info')
})
