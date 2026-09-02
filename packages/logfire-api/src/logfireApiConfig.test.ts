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

test('rejects a LOGFIRE_SEND_TO_LOGFIRE value that is neither a boolean nor the sentinel', () => {
  const token = 'pylf_v1_us_token'

  // `Boolean('yes')` is true, so a typo used to turn sending on rather than being reported.
  expect(() => resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'yes' }, undefined, token)).toThrow(
    `Expected LOGFIRE_SEND_TO_LOGFIRE to be a boolean or 'if-token-present', got "yes"`
  )
  // A boolean passed in code still resolves without touching the env var.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'yes' }, false, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'yes' }, true, undefined)).toBe(true)
})

test('reads LOGFIRE_SEND_TO_LOGFIRE=false as disabled', () => {
  const token = 'pylf_v1_us_1234567890'

  // The env var is a string, so plain truthiness would keep sending on 'false'.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'false' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'FALSE' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: ' false ' }, undefined, token)).toBe(false)

  // The Python SDK reads 0/f and 1/t as booleans; string truthiness would
  // read '0' as enabled.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: '0' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'f' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'F' }, undefined, token)).toBe(false)

  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'true' }, undefined, undefined)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: '1' }, undefined, undefined)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 't' }, undefined, undefined)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'if-token-present' }, undefined, token)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'if-token-present' }, undefined, undefined)).toBe(false)

  // The sentinel is normalized the same way, so a differently cased or padded
  // spelling still requires a token rather than falling through to truthiness.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'IF-TOKEN-PRESENT' }, undefined, undefined)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: ' if-token-present ' }, undefined, undefined)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'IF-TOKEN-PRESENT' }, undefined, token)).toBe(true)

  // An empty or blank value is not a documented spelling and disables sending.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: '' }, undefined, token)).toBe(false)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: '   ' }, undefined, token)).toBe(false)

  // An explicit option still wins over the environment.
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'false' }, true, token)).toBe(true)
  expect(resolveSendToLogfire({ LOGFIRE_SEND_TO_LOGFIRE: 'true' }, false, token)).toBe(false)
})
