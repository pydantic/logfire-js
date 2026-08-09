import { expect, test } from 'vite-plus/test'

import { resolveBaseUrl, resolveSendToLogfire } from './logfireApiConfig'

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

test('reads LOGFIRE_SEND_TO_LOGFIRE=false as disabled', () => {
  const token = 'pylf_v1_us_1234567890'

  // The env var is a string, so plain truthiness would keep sending on 'false'.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'false' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'FALSE' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: ' false ' }, undefined, token)).toBe(false)

  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'true' }, undefined, undefined)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'if-token-present' }, undefined, token)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'if-token-present' }, undefined, undefined)).toBe(false)

  // An explicit option still wins over the environment.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'false' }, true, token)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'true' }, false, token)).toBe(false)
})
