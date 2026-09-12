import { describe, expect, it } from 'vite-plus/test'

import { applySettings, parseAgentConfig } from '../index'
import type { AgentSupport } from '../index'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

/** An adapter that can lower two settings and apply no other section. */
const SETTINGS_ONLY: AgentSupport = { sections: ['settings'], settings: ['temperature', 'max_tokens'] }

describe('applySettings', () => {
  it('returns only the keys the value actually set, so the result is a patch', () => {
    const config = parseAgentConfig({ settings: { temperature: 0.2, thinking: 'high' } })
    expect(applySettings(config)).toEqual({ settings: { temperature: 0.2, thinking: 'high' }, issues: [] })
  })

  it('returns an empty patch when nothing is published, which merges to a no-op', () => {
    expect(applySettings({})).toEqual({ settings: {}, issues: [] })
    expect(applySettings(parseAgentConfig({ settings: {} }))).toEqual({ settings: {}, issues: [] })
  })

  it('keeps a falsy value, which is a setting and not an absence', () => {
    const config = parseAgentConfig({ settings: { temperature: 0, parallel_tool_calls: false } })
    expect(applySettings(config).settings).toEqual({ temperature: 0, parallel_tool_calls: false })
  })

  it('reports nothing itself, whatever it could not apply', () => {
    // The policy is applied once per request, by `AgentControl.report`. It used to be applied here,
    // per key, which is why an adapter had to remember to call a second reporter for the keys *it*
    // could not lower -- and a forgotten call was a silent drop.
    const config = parseAgentConfig({ settings: { service_tier: 'flex' } })
    expect(applySettings(config).issues).toHaveLength(1)
    expect(warnings.messages).toEqual([])
  })

  describe('a key this SDK has no field for', () => {
    const config = parseAgentConfig({ settings: { service_tier: 'flex', temperature: 0.2 } })

    it('comes back as an issue, and the rest of the patch still applies', () => {
      const { settings, issues } = applySettings(config)
      expect(settings).toEqual({ temperature: 0.2 })
      expect(issues.map((issue) => [issue.section, issue.reason, issue.setting])).toEqual([['settings', 'unknown-setting', 'service_tier']])
      expect(issues[0]?.message).toBe(
        "Managed agent config sets 'service_tier', which this version of the SDK has no model setting for; that key is not applied."
      )
    })
  })

  describe('a canonical key this adapter cannot lower', () => {
    const config = parseAgentConfig({ settings: { temperature: 0.4, top_k: 40 } })

    it('is dropped and reported, which this core could not do at all before', () => {
      // There was no support filtering here: an adapter filtered the patch itself and then called a
      // reporter of its own, so the two could disagree and a forgotten call said nothing.
      const { settings, issues } = applySettings(config, { support: SETTINGS_ONLY })
      expect(settings).toEqual({ temperature: 0.4 })
      expect(issues.map((issue) => [issue.section, issue.reason, issue.setting])).toEqual([['settings', 'unsupported-setting', 'top_k']])
      expect(issues[0]?.message).toContain("sets 'top_k', which this agent framework has no model setting for")
    })

    it('is applied when no support is declared, which says the adapter can lower all of them', () => {
      expect(applySettings(config).settings).toEqual({ temperature: 0.4, top_k: 40 })
      expect(applySettings(config, { support: null }).settings).toEqual({ temperature: 0.4, top_k: 40 })
    })

    it('is every canonical key when the declaration lists none', () => {
      const { settings, issues } = applySettings(config, { support: { sections: ['settings'] } })
      expect(settings).toEqual({})
      expect(issues.map((issue) => issue.setting)).toEqual(['temperature', 'top_k'])
    })
  })

  describe('a whole section this adapter cannot apply', () => {
    it('is reported once, rather than being silently ignored', () => {
      const config = parseAgentConfig({
        instructions: ['Be brief.'],
        model: 'openai:gpt-5.6-sol',
        settings: { temperature: 0.4 },
      })
      const { settings, issues } = applySettings(config, { support: SETTINGS_ONLY })
      expect(settings).toEqual({ temperature: 0.4 })
      expect(issues.map((issue) => [issue.section, issue.reason])).toEqual([
        ['instructions', 'unsupported-section'],
        ['model', 'unsupported-section'],
      ])
      expect(issues[1]?.message).toContain("publishes a 'model' section, which this agent framework has no way to apply")
    })

    it('says nothing about a section the adapter declares', () => {
      const config = parseAgentConfig({ model: 'openai:gpt-5.6-sol' })
      expect(applySettings(config, { support: { sections: ['model'] } }).issues).toEqual([])
    })

    it('says nothing when no support is declared, because nothing said it could not', () => {
      expect(applySettings(parseAgentConfig({ model: 'openai:gpt-5.6-sol' })).issues).toEqual([])
    })
  })

  describe('a top-level key this release has no section for', () => {
    it('is reported rather than dropped in silence', () => {
      // The openness is deliberate -- it is what lets a future section be published against an older
      // SDK -- but a drop nobody hears about is a silently degraded agent.
      const config = parseAgentConfig({ instructions: ['Be brief.'], mcp_servers: [{ name: 'crm' }], skills: [] })
      const { issues } = applySettings(config)
      expect(issues.map((issue) => [issue.section, issue.reason])).toEqual([
        ['mcp_servers', 'unknown-section'],
        ['skills', 'unknown-section'],
      ])
      expect(issues[0]?.message).toContain("publishes a 'mcp_servers' section, which this version of the SDK has no section for")
    })

    it('is nothing for a config an adapter built itself, which has no published keys', () => {
      expect(applySettings({ model: 'openai:gpt-5.6-sol' }).issues).toEqual([])
    })

    it('does not reach the published value, so a baseline still serializes to the contract', () => {
      const config = parseAgentConfig({ model: 'openai:gpt-5.6-sol', mcp_servers: [] })
      expect(JSON.parse(JSON.stringify(config))).toEqual({ model: 'openai:gpt-5.6-sol' })
    })
  })
})

describe('a published timeout that is not a budget a request can be given', () => {
  const config = parseAgentConfig({ settings: { timeout: -1, temperature: 0.2 } })

  it('is dropped rather than clamped, and the rest of the patch still applies', () => {
    // Clamping turns "no real limit" into a deadline nobody published, and rounding a negative one
    // to `0` cancels the request before it is sent.
    const { settings, issues } = applySettings(config)
    expect(settings).toEqual({ temperature: 0.2 })
    expect(issues.map((issue) => [issue.reason, issue.setting])).toEqual([['unrepresentable-timeout', 'timeout']])
    expect(issues[0]?.message).toContain('sets a request timeout of -1 seconds')
  })

  it('is judged in the canonical key order, so an issue lands in the same place in both cores', () => {
    // Judging the timeout in a pass of its own would put it ahead of the keys an adapter cannot
    // lower here and behind them in Python, for the same published value.
    const both = parseAgentConfig({ settings: { timeout: -1, top_k: 40 } })
    const { issues } = applySettings(both, { support: SETTINGS_ONLY })
    expect(issues.map((issue) => issue.reason)).toEqual(['unsupported-setting', 'unrepresentable-timeout'])
  })

  it('leaves a representable one alone, zero included', () => {
    expect(applySettings(parseAgentConfig({ settings: { timeout: 0 } })).settings).toEqual({ timeout: 0 })
    expect(applySettings(parseAgentConfig({ settings: { timeout: 30 } })).settings).toEqual({ timeout: 30 })
  })
})
