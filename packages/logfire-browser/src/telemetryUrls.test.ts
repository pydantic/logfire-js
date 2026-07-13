import { afterEach, describe, expect, it } from 'vite-plus/test'

import { assertBrowserReplayUrl, createTelemetryUrlPatterns } from './telemetryUrls'

const originalLocation = globalThis.location
const originalDocument = globalThis.document

afterEach(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
})

function setBrowserBases(locationHref: string, baseURI: string): void {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(locationHref),
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { baseURI },
  })
}

function matches(patterns: RegExp[], url: string): boolean {
  return patterns.some((pattern) => pattern.test(url))
}

describe('createTelemetryUrlPatterns', () => {
  it('matches raw and both canonical forms without suppressing descendants', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://cdn.example/assets/')
    const patterns = createTelemetryUrlPatterns([{ kind: 'exact', url: 'telemetry/traces' }])

    expect(matches(patterns, 'telemetry/traces')).toBe(true)
    expect(matches(patterns, 'https://app.example/nested/page/telemetry/traces')).toBe(true)
    expect(matches(patterns, 'https://cdn.example/assets/telemetry/traces')).toBe(true)
    expect(matches(patterns, 'https://app.example/nested/page/telemetry/traces?batch=1#receipt')).toBe(true)
    expect(matches(patterns, 'https://app.example/nested/page/telemetry/traces/child')).toBe(false)
    expect(matches(patterns, 'https://app.example/nested/page/telemetry/traces-v2')).toBe(false)
  })

  it('preserves exact trailing slash, query, fragment, and root semantics', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://app.example/nested/page/')
    const trailing = createTelemetryUrlPatterns([{ kind: 'exact', url: '/traces/' }])
    const query = createTelemetryUrlPatterns([{ kind: 'exact', url: '/metrics?format=json' }])
    const fragment = createTelemetryUrlPatterns([{ kind: 'exact', url: '/metrics#configured' }])
    const root = createTelemetryUrlPatterns([{ kind: 'exact', url: '/' }])

    expect(matches(trailing, 'https://app.example/traces/')).toBe(true)
    expect(matches(trailing, 'https://app.example/traces')).toBe(false)
    expect(matches(query, 'https://app.example/metrics?format=json#receipt')).toBe(true)
    expect(matches(query, 'https://app.example/metrics?format=proto')).toBe(false)
    expect(matches(fragment, 'https://app.example/metrics#configured')).toBe(true)
    expect(matches(fragment, 'https://app.example/metrics#other')).toBe(false)
    expect(matches(root, 'https://app.example/?batch=1')).toBe(true)
    expect(matches(root, 'https://app.example/application')).toBe(false)
  })

  it('matches only replay session children and normalizes replay trailing slashes', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://app.example/nested/page/')
    const patterns = createTelemetryUrlPatterns([{ kind: 'replay-base', url: '/client-replay/' }])

    expect(matches(patterns, '/client-replay/session-1?seq=0')).toBe(true)
    expect(matches(patterns, 'https://app.example/client-replay/session-1?seq=0')).toBe(true)
    expect(matches(patterns, '/client-replay')).toBe(false)
    expect(matches(patterns, '/client-replay/session-1/chunk')).toBe(false)
    expect(matches(patterns, '/client-replay-other/session-1')).toBe(false)
  })

  it('matches absolute endpoint forms and escapes regex metacharacters', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://cdn.example/assets/')
    const exact = createTelemetryUrlPatterns([{ kind: 'exact', url: 'https://telemetry.example/v1/traces.+(test)' }])
    const replay = createTelemetryUrlPatterns([{ kind: 'replay-base', url: 'https://telemetry.example/v1/replay.+' }])

    expect(matches(exact, 'https://telemetry.example/v1/traces.+(test)')).toBe(true)
    expect(matches(exact, 'https://telemetry.example/v1/traces-xxxtest')).toBe(false)
    expect(matches(replay, 'https://telemetry.example/v1/replay.+/session%2F1?seq=0')).toBe(true)
    expect(matches(replay, 'https://telemetry.example/v1/replay-xx/session-1')).toBe(false)
  })

  it('keeps invalid and empty raw exact endpoints matchable', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://cdn.example/assets/')
    const invalid = createTelemetryUrlPatterns([{ kind: 'exact', url: 'http://[invalid' }])
    const empty = createTelemetryUrlPatterns([{ kind: 'exact', url: '' }])

    expect(matches(invalid, 'http://[invalid')).toBe(true)
    expect(matches(invalid, 'http://xinvalid')).toBe(false)
    expect(matches(empty, '')).toBe(true)
    expect(matches(empty, '/')).toBe(false)
  })

  it('deduplicates identical raw and canonical forms', () => {
    setBrowserBases('https://app.example/', 'https://app.example/')
    const patterns = createTelemetryUrlPatterns([
      { kind: 'exact', url: 'https://app.example/client-traces' },
      { kind: 'exact', url: 'https://app.example/client-traces' },
    ])

    expect(patterns).toHaveLength(1)
  })
})

describe('assertBrowserReplayUrl', () => {
  it('accepts an absolute or relative non-root path without query or fragment', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://app.example/nested/page/')
    expect(() => {
      assertBrowserReplayUrl('/client-replay')
    }).not.toThrow()
    expect(() => {
      assertBrowserReplayUrl('replay')
    }).not.toThrow()
  })

  it.each(['', '/', 'https://app.example/', '/client-replay?token=x', '/client-replay#fragment'])(
    'rejects ambiguous replay URL %s',
    (url) => {
      setBrowserBases('https://app.example/nested/page/', 'https://app.example/nested/page/')
      expect(() => {
        assertBrowserReplayUrl(url)
      }).toThrow(/sessionReplay\.replayUrl/u)
    }
  )

  it('rejects a replay URL that resolves to root against either browser base', () => {
    setBrowserBases('https://app.example/nested/page/', 'https://app.example/')
    expect(() => {
      assertBrowserReplayUrl('..')
    }).toThrow(/non-root path/u)
  })
})
