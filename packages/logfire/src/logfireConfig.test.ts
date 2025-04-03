import { expect, test } from 'vitest'

import { resolveBaseUrl } from './logfireConfig'

test('returns the passed url', () => {
  const baseUrl = resolveBaseUrl('https://example.com', 'token')
  expect(baseUrl).toBe('https://example.com')
})

test('resolves the US base url from the token', () => {
  const baseUrl = resolveBaseUrl(undefined, 'pylf_v1_us_1234567890')
  expect(baseUrl).toBe('https://logfire-us.pydantic.dev')
})

test('resolves the EU base url from the token', () => {
  const baseUrl = resolveBaseUrl(undefined, 'pylf_v1_eu_mFMvBQ7BWLPJ0fHYBGLVBmJ70TpkhlskgRLng0jFsb3n')
  expect(baseUrl).toBe('https://logfire-eu.pydantic.dev')
})
