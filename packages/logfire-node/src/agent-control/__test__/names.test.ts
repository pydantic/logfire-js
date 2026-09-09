import { describe, expect, it } from 'vite-plus/test'

import { AGENT_VARIABLE_PREFIX, agentVariableName, normalizeAgentName } from '../index'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

describe('normalizeAgentName', () => {
  it('reduces a display name to the key its variable is built from', () => {
    // The rule, in the order it runs: trim, lowercase, replace, collapse, strip.
    expect(normalizeAgentName('  Checkout Assistant  ')).toBe('checkout_assistant')
    expect(normalizeAgentName('a -- b')).toBe('a_b')
    expect(normalizeAgentName('_leading_and_trailing_')).toBe('leading_and_trailing')
  })

  it('gives one key to names that differ only in punctuation or case, which is the point', () => {
    // Lossy on purpose: it is what makes a Pydantic AI `Checkout Assistant` and a Mastra
    // `checkout-assistant` the one config the Logfire UI shows for them.
    const keys = ['checkout-assistant', 'Checkout Assistant', 'checkout_assistant', 'checkout.assistant']
    expect(new Set(keys.map(normalizeAgentName))).toEqual(new Set(['checkout_assistant']))
  })

  it('returns the empty string for a name with nothing usable in it', () => {
    expect(normalizeAgentName('   ')).toBe('')
    expect(normalizeAgentName('---')).toBe('')
    expect(normalizeAgentName('日本語')).toBe('')
  })
})

describe('agentVariableName', () => {
  it('is the prefix plus the key', () => {
    expect(agentVariableName('checkout-assistant')).toBe(`${AGENT_VARIABLE_PREFIX}checkout_assistant`)
  })

  it('warns rather than doubling a prefix the caller passed itself', () => {
    expect(agentVariableName('agent__checkout')).toBe('agent__checkout')
    expect(warnings.messages).toEqual([
      "The 'agent__' prefix is added automatically; pass the bare agent name rather than 'agent__checkout'.",
    ])
  })

  it('refuses a name with no key in it, naming the rule and what it needs', () => {
    expect(() => agentVariableName('---')).toThrow(/has nothing a variable key can be made of/u)
    expect(() => agentVariableName('---')).toThrow(/at least one ASCII letter, digit, or underscore/u)
  })
})
