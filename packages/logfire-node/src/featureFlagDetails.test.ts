import { ResolvedVariable } from 'logfire/vars'
import type { FlagProviderState, ResolvedVariableInit } from 'logfire/vars'
import { describe, expect, it } from 'vite-plus/test'

import { toFlagDetails } from './featureFlagDetails'

describe('feature flag details', () => {
  it.each([
    ['missing_config', 'not_ready', 'provider_not_ready'],
    ['missing_config', 'error', 'general'],
    ['other_error', 'ready', 'general'],
    ['unrecognized_variable', 'stale', 'flag_not_found'],
    ['validation_error', 'stale', 'type_mismatch'],
  ] as const)('reports %s under %s as %s without variant metadata', (reason, state: FlagProviderState, errorCode) => {
    const rejected = new ResolvedVariable({ name: 'checkout', value: false, label: 'bad-label', version: 2, reason })
    expect(toFlagDetails(rejected, state)).toEqual({ flagKey: 'checkout', value: false, reason: 'error', errorCode })
  })

  it('distinguishes a stale published value from a local override', () => {
    const config: ResolvedVariableInit<boolean> = { name: 'checkout', value: true, reason: 'resolved', label: 'on', version: 8 }
    expect(toFlagDetails(new ResolvedVariable(config), 'stale')).toEqual({
      flagKey: 'checkout',
      reason: 'stale',
      value: true,
      valueVersion: 8,
      variant: 'on',
    })

    expect(toFlagDetails(new ResolvedVariable({ ...config, reason: 'context_override' }), 'not_ready')).toEqual({
      flagKey: 'checkout',
      reason: 'context_override',
      value: true,
    })
  })

  it('does not return a mutable reference to a reusable default', () => {
    const value = { limits: [1, 2] }
    const resolution = new ResolvedVariable({ name: 'policy', reason: 'code_default', value })
    toFlagDetails(resolution, 'ready').value.limits.push(3)
    expect(toFlagDetails(resolution, 'ready').value).toEqual({ limits: [1, 2] })
  })
})
