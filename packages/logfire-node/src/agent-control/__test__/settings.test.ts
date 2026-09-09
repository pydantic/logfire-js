import { describe, expect, it } from 'vite-plus/test'

import { applySettings, parseAgentConfig, reportUnapplied, UnmatchedConfigError } from '../index'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

describe('applySettings', () => {
  it('returns only the keys the value actually set, so the result is a patch', () => {
    const config = parseAgentConfig({ settings: { temperature: 0.2, thinking: 'high' } })
    expect(applySettings(config)).toEqual({ temperature: 0.2, thinking: 'high' })
  })

  it('returns an empty patch when nothing is published, which merges to a no-op', () => {
    expect(applySettings({})).toEqual({})
    expect(applySettings(parseAgentConfig({ settings: {} }))).toEqual({})
  })

  it('keeps a falsy value, which is a setting and not an absence', () => {
    const config = parseAgentConfig({ settings: { temperature: 0, parallel_tool_calls: false } })
    expect(applySettings(config)).toEqual({ temperature: 0, parallel_tool_calls: false })
  })

  describe('a key this SDK has no field for', () => {
    const config = parseAgentConfig({ settings: { service_tier: 'flex', temperature: 0.2 } })

    it('is reported here, where the patch is applied, and the rest still applies', () => {
      expect(applySettings(config)).toEqual({ temperature: 0.2 })
      expect(warnings.messages).toEqual([
        "Managed agent config sets 'service_tier', which this version of the SDK has no model setting for; that key is not applied.",
      ])
    })

    it('says nothing under ignore', () => {
      expect(applySettings(config, { onUnmatched: 'ignore' })).toEqual({ temperature: 0.2 })
      expect(warnings.messages).toEqual([])
    })

    it('fails the run under error', () => {
      expect(() => applySettings(config, { onUnmatched: 'error' })).toThrow(UnmatchedConfigError)
    })
  })
})

describe('reportUnapplied', () => {
  it("warns for a key the adapter's own framework cannot lower", () => {
    reportUnapplied(['top_k'])
    expect(warnings.messages).toEqual([
      "Managed agent config sets 'top_k', which this agent framework has no model setting for; that key is not applied.",
    ])
  })

  it('is a no-op when the adapter applied everything', () => {
    reportUnapplied([])
    expect(warnings.messages).toEqual([])
  })

  it('says nothing under ignore and fails the run under error', () => {
    reportUnapplied(['seed'], { onUnmatched: 'ignore' })
    expect(warnings.messages).toEqual([])
    expect(() => {
      reportUnapplied(['seed'], { onUnmatched: 'error' })
    }).toThrow(UnmatchedConfigError)
  })
})

describe('a published timeout that is not a budget a request can be given', () => {
  const config = parseAgentConfig({ settings: { timeout: -1, temperature: 0.2 } })

  it('is dropped rather than clamped, and the rest of the patch still applies', () => {
    // Clamping turns "no real limit" into a deadline nobody published, and rounding a negative one
    // to `0` cancels the request before it is sent.
    expect(applySettings(config)).toEqual({ temperature: 0.2 })
    expect(warnings.messages[0]).toContain('sets a request timeout of -1 seconds')
  })

  it('goes through onUnmatched like every other key that is not applied', () => {
    expect(applySettings(config, { onUnmatched: 'ignore' })).toEqual({ temperature: 0.2 })
    expect(warnings.messages).toEqual([])
    expect(() => applySettings(config, { onUnmatched: 'error' })).toThrow(UnmatchedConfigError)
  })

  it('leaves a representable one alone, zero included', () => {
    expect(applySettings(parseAgentConfig({ settings: { timeout: 0 } }))).toEqual({ timeout: 0 })
    expect(applySettings(parseAgentConfig({ settings: { timeout: 30 } }))).toEqual({ timeout: 30 })
  })
})
