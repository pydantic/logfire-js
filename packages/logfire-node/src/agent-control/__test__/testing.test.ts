import { describe, expect, it, vi } from 'vite-plus/test'

import { AgentControl, buildBaseline, warnOnce } from '../index'
import { resetAgentControl, resetProcessState, resetWarnings } from '../testing'
import { captureWarnings, settle, storedConfigFor, useLocalVariables } from './helpers'

const warnings = captureWarnings()

describe('warnOnce', () => {
  it('is exported for adapters, which had been copying it', () => {
    warnOnce('an adapter said something')
    warnOnce('an adapter said something')
    expect(warnings.messages).toEqual(['an adapter said something'])
  })
})

describe('the testing entry point', () => {
  it('clears the warning memory, so a suite can assert a message more than once', () => {
    warnOnce('said once')
    warnOnce('said once')
    expect(warnings.messages).toEqual(['said once'])

    resetWarnings()
    warnOnce('said once')
    expect(warnings.messages).toEqual(['said once', 'said once'])
  })

  it('clears the publish guard, so a suite can assert a publish more than once', async () => {
    useLocalVariables()
    const baseline = buildBaseline({ model: 'openai:gpt-5.6-sol' })
    new AgentControl('checkout').publishBaseline(baseline)
    await settle()
    expect(storedConfigFor('agent__checkout')).toBeDefined()

    // Without the reset the second suite to publish this variable would silently write nothing, and
    // its assertion would fail for a reason that has nothing to do with what it was testing.
    useLocalVariables()
    new AgentControl('checkout').publishBaseline(baseline)
    await settle()
    expect(storedConfigFor('agent__checkout')).toBeUndefined()

    resetProcessState()
    new AgentControl('checkout').publishBaseline(baseline)
    await settle()
    expect(storedConfigFor('agent__checkout')).toBeDefined()
  })

  it('clears both at once, which is what a `beforeEach` wants', async () => {
    useLocalVariables()
    warnOnce('said once')
    new AgentControl('checkout').publishBaseline(buildBaseline({ model: 'openai:gpt-5.6-sol' }))
    await settle()

    resetAgentControl()
    useLocalVariables()
    warnOnce('said once')
    new AgentControl('checkout').publishBaseline(buildBaseline({ model: 'openai:gpt-5.6-sol' }))
    await settle()

    expect(warnings.messages).toEqual(['said once', 'said once'])
    expect(storedConfigFor('agent__checkout')).toBeDefined()
  })

  it('is reachable at the published subpath, not just from source', async () => {
    // The `exports` map is what an adapter actually imports through, so a missing entry is a break
    // that no source-relative test would ever catch.
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const pkg = require('../../../package.json') as { exports: Record<string, Record<string, unknown>> }
    expect(pkg.exports['./agent-control/testing']).toEqual({
      import: {
        types: './dist/agent-control/testing.d.ts',
        default: './dist/agent-control/testing.js',
      },
      require: {
        types: './dist/agent-control/testing.d.cts',
        default: './dist/agent-control/testing.cjs',
      },
    })
  })

  it('does not leak the resets into the runtime entry point', async () => {
    const index = await import('../index')
    expect(Object.keys(index)).not.toContain('resetWarnings')
    expect(Object.keys(index)).not.toContain('resetProcessState')
    expect(Object.keys(index)).not.toContain('resetAgentControl')
    vi.resetModules()
  })
})
