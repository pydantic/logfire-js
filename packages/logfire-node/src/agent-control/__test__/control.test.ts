import { createHash } from 'node:crypto'

import { configureLogfireApi } from 'logfire'
import { configureVariables, getVariableProvider } from 'logfire/vars'
import type { SerializedResolvedVariable, VariableConfig } from 'logfire/vars'
import { describe, expect, it } from 'vite-plus/test'

import { AgentControl, buildBaseline, canonicalJson, SCHEMA_SHA256, UnmatchedConfigError } from '../index'
import type { AgentConfig, ApplyIssue, ReportBaselineOptions, ToolDef } from '../index'
import { resetProcessState } from '../testing'
import {
  captureWarnings,
  collectHints,
  collectSpans,
  emptyVariable,
  hintAttributes,
  publishedValue,
  storedConfigFor,
  useDeployment,
  useLocalVariables,
  useNoVariables,
} from './helpers'
import type { CapturedSpan } from './helpers'

const warnings = captureWarnings()

/** A provider that fails every read, the way an unreachable Logfire API does. */
function useBrokenProvider(): void {
  configureVariables(false)
  const provider = getVariableProvider() as {
    getSerializedValue: () => Promise<SerializedResolvedVariable>
  }
  provider.getSerializedValue = async () => Promise.reject(new Error('connection refused'))
}

describe('AgentControl', () => {
  it('backs an agent with the `agent__<name>` variable the Logfire UI lists', () => {
    const control = new AgentControl('checkout_assistant')
    expect(control.name).toBe('checkout_assistant')
    expect(control.variableName).toBe('agent__checkout_assistant')
    expect(control.onUnmatched).toBe('warn')
    expect(control.label).toBeUndefined()
  })

  it('refuses a name with no variable key in it, rather than pointing every agent at one config', () => {
    expect(() => new AgentControl('')).toThrow(/has nothing a variable key can be made of/u)
    expect(() => new AgentControl('   ')).toThrow(/has nothing a variable key can be made of/u)
  })

  it('keeps the display name verbatim and normalizes only the variable key', () => {
    // Two SDKs and the Logfire UI have to land on one variable for one agent, so the key is
    // normalized; the name a person recognizes the agent by is not.
    const control = new AgentControl('Checkout Assistant')
    expect(control.name).toBe('Checkout Assistant')
    expect(control.variableName).toBe('agent__checkout_assistant')
    expect(new AgentControl('checkout-assistant').variableName).toBe(control.variableName)
    expect(new AgentControl('  checkout  ').name).toBe('checkout')
  })

  it('shares one variable between two controls for the same agent', () => {
    // `defineVar` refuses a name it has already registered, and two controls for one agent is an
    // ordinary thing for an adapter to end up with.
    expect(() => [new AgentControl('twice'), new AgentControl('twice')]).not.toThrow()
  })

  it("falls back to an unregistered variable when the name is already someone else's", async () => {
    const { defineVar } = await import('logfire/vars')
    defineVar('agent__taken', { default: {} })
    useLocalVariables(publishedValue('agent__taken', { model: 'openai:gpt-5.6-sol' }))
    // Still resolves: the registry entry is theirs, but the variable reads the same name through the
    // same provider.
    expect(await new AgentControl('taken', { label: 'production' }).resolve()).toEqual({
      model: 'openai:gpt-5.6-sol',
    })
  })

  describe('resolve', () => {
    it('returns the published value for the label it was given', async () => {
      useLocalVariables(publishedValue('agent__checkout', { instructions: 'Be brief.', model: 'openai:gpt-5.6-sol' }, 'production'))
      const control = new AgentControl('checkout', { label: 'production' })
      expect(await control.resolve()).toEqual({
        instructions: 'Be brief.',
        model: 'openai:gpt-5.6-sol',
      })
    })

    it("returns the rollout's choice when no label is pinned", async () => {
      useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
      expect(await new AgentControl('checkout').resolve()).toEqual({ model: 'openai:gpt-5.6-sol' })
    })

    it('returns null when nothing is published, so an adapter can tell managed from unmanaged', async () => {
      useLocalVariables(emptyVariable('agent__checkout'))
      expect(await new AgentControl('checkout').resolve()).toBeNull()
      expect(warnings.messages).toEqual([])
    })

    it('returns null when the variable does not exist at all', async () => {
      useLocalVariables()
      expect(await new AgentControl('checkout').resolve()).toBeNull()
      expect(warnings.messages).toEqual([])
    })

    it('returns null when variables are switched off', async () => {
      useNoVariables()
      expect(await new AgentControl('checkout').resolve()).toBeNull()
      expect(warnings.messages).toEqual([])
    })

    it('applies the lenient parse, so one bad field does not un-manage the rest', async () => {
      useLocalVariables(
        publishedValue('agent__checkout', {
          model: 'openai:gpt-5.6-sol',
          settings: { temperature: 'warm', max_tokens: 100 },
        })
      )
      expect(await new AgentControl('checkout').resolve()).toEqual({
        model: 'openai:gpt-5.6-sol',
        settings: { max_tokens: 100 },
      })
      expect(warnings.messages[0]).toContain("setting 'temperature' has invalid value")
    })

    describe('when the provider is down', () => {
      it('returns null and warns once, so the agent keeps running on code', async () => {
        useBrokenProvider()
        const control = new AgentControl('checkout')
        expect(await control.resolve()).toBeNull()
        expect(await control.resolve()).toBeNull()
        expect(warnings.messages).toEqual([
          "Logfire managed variable 'agent__checkout' could not be resolved (other_error); running on the code-defined agent.",
        ])
      })
    })

    it('returns null and warns when the published value itself cannot be resolved', async () => {
      // Nothing this package writes can land here -- `parseAgentConfig` never throws -- but a
      // composition reference the value cannot expand does, and the agent runs on code either way.
      useLocalVariables(publishedValue('agent__checkout', '@{no_such_variable}@'))
      expect(await new AgentControl('checkout', { label: 'production' }).resolve()).toBeNull()
      expect(warnings.messages).toContain(
        "Logfire managed variable 'agent__checkout' could not be resolved (other_error); running on the code-defined agent."
      )
    })
  })

  describe('reportBaseline', () => {
    const baseline = buildBaseline({
      instructions: [{ id: 'agent', text: 'You are a checkout assistant.', dynamic: false }],
      model: 'openai:gpt-5.6-sol',
    })
    /** The digest of the canonical form of `baseline`; see the cross-language test below. */
    const BASELINE_SHA256 = '86905062a7aa7d426d155908a0133fc847a3d91b07ead15cdb2e57086920ad50'

    /** Resolve, report, and hand back the hint spans that produced. */
    async function reported(
      control: AgentControl,
      what: AgentConfig = baseline,
      options: ReportBaselineOptions = {}
    ): Promise<Record<string, unknown>[]> {
      return collectHints(async () => {
        control.reportBaseline(what, await control.resolution(), options)
      })
    }

    it('reports the whole contract on one `agent_control_config_hint` span', async () => {
      useLocalVariables()
      useDeployment({ serviceName: 'checkout-api', environment: 'prod', serviceVersion: 'abc123' })
      const spans = await collectSpans(async () => {
        const control = new AgentControl('checkout')
        control.reportBaseline(baseline, await control.resolution())
      })
      // The span *name* is what a Logfire-side query selects a hint by, and the message is what a
      // person reads; both are the contract, and both are shared byte for byte with the Python core.
      expect(spans.map((span) => span.name)).toEqual(['agent_control_config_hint'])
      expect(spans[0]?.attributes['logfire.msg']).toBe('Agent Control reported the code baseline for this agent')
      expect(hintAttributes(spans[0] as CapturedSpan)).toEqual({
        'agent_control.variable_name': 'agent__checkout',
        'agent_control.agent_name': 'checkout',
        'agent_control.framework': 'logfire-node',
        'agent_control.baseline_source': 'code',
        'agent_control.schema_sha256': SCHEMA_SHA256,
        'agent_control.baseline_sha256': BASELINE_SHA256,
        'agent_control.baseline_reduction': 'none',
        'agent_control.baseline_bytes': 171,
        'agent_control.resolution_reason': 'code_default',
        'agent_control.service_name': 'checkout-api',
        'agent_control.environment': 'prod',
        'agent_control.service_version': 'abc123',
        'agent_control.baseline': JSON.stringify(baseline, null, 2),
      })
    })

    it('is reported as written, with scrubbing at its default', async () => {
      // Scrubbing is on unless a project turns it off, and it matches substrings: `auth`, `session`
      // and `token` are ordinary words in a prompt, a tool description, an agent's name and a
      // service's name. Every string here matches one -- the instruction says "authoritative", the
      // tool description says "authorization", the agent is an `auth_router`, the service is a
      // `checkout-session-api`, and the deployment is a preview environment named after its branch.
      // The baseline is the document a config is created from, so a redaction inside it is a
      // corrupted document rather than a hidden secret, and one that no longer matches the digest or
      // the byte count. A redacted `variable_name` is worse: the hint names no variable at all. The
      // exemption is `SAFE_KEYS` in `logfire-api`; this test is what holds the six keys there.
      useLocalVariables()
      useDeployment({
        serviceName: 'checkout-session-api',
        environment: 'pr-auth-refresh',
        serviceVersion: '1.4.0+authz.2',
      })
      const instructions = 'Order tools are authoritative for status and refunds.'
      const description = 'Refund an order the customer has authorization for.'
      const matching = buildBaseline({
        instructions: [{ id: 'agent', text: instructions, dynamic: false }],
        tools: [
          {
            name: 'refund_order',
            description,
            parametersJsonSchema: { properties: { order_id: { description: 'The order to refund.' } } },
            toolset: 'orders',
          },
        ],
      })
      const hints = await reported(new AgentControl('auth_router'), matching)

      const carried = JSON.parse(hints[0]?.['agent_control.baseline'] as string) as AgentConfig
      expect(carried).toEqual(matching)
      expect(hints[0]?.['agent_control.variable_name']).toBe('agent__auth_router')
      expect(hints[0]?.['agent_control.agent_name']).toBe('auth_router')
      expect(hints[0]?.['agent_control.service_name']).toBe('checkout-session-api')
      expect(hints[0]?.['agent_control.environment']).toBe('pr-auth-refresh')
      expect(hints[0]?.['agent_control.service_version']).toBe('1.4.0+authz.2')
      // The two promises a reduction of `'none'` makes to a consumer, checked against the document
      // the span carries rather than the one this process built.
      expect(hints[0]?.['agent_control.baseline_reduction']).toBe('none')
      expect(hints[0]?.['agent_control.baseline_sha256']).toBe(createHash('sha256').update(canonicalJson(carried), 'utf8').digest('hex'))
      expect(hints[0]?.['agent_control.baseline_bytes']).toBe(Buffer.byteLength(hints[0]?.['agent_control.baseline'] as string))
    })

    it('never creates or updates a variable', async () => {
      // The whole point of the hint. Registration is a person's click on a platform-side flow, so an
      // SDK that wrote the variable itself would be making that decision for them -- and its write
      // path is a read-modify-write the platform API offers no conditional write for.
      useLocalVariables()
      const provider = getVariableProvider() as {
        createVariable: unknown
        updateVariable: unknown
      }
      const wrote: string[] = []
      provider.createVariable = (config: VariableConfig) => {
        wrote.push(`create ${config.name}`)
        return config
      }
      provider.updateVariable = (name: string, config: VariableConfig) => {
        wrote.push(`update ${name}`)
        return config
      }
      expect(await reported(new AgentControl('checkout'))).toHaveLength(1)
      expect(wrote).toEqual([])
      expect(storedConfigFor('agent__checkout')).toBeUndefined()
      expect(warnings.messages).toEqual([])
    })

    it('says which agent landed on the key, keeping the name as written', async () => {
      // The variable name is derived from the agent's name lossily, so the hint is the only thing
      // that says *which* agent is behind `agent__checkout_assistant`.
      useLocalVariables()
      const hints = await reported(new AgentControl('Checkout Assistant'))
      expect(hints[0]?.['agent_control.variable_name']).toBe('agent__checkout_assistant')
      expect(hints[0]?.['agent_control.agent_name']).toBe('Checkout Assistant')
    })

    it('leaves off deployment identity the SDK does not know', async () => {
      // Absent is a state a consumer can act on; `''` is a value it has to learn to disbelieve.
      useLocalVariables()
      useDeployment({ serviceVersion: 'abc123' })
      const hints = await reported(new AgentControl('checkout'))
      expect(hints[0]).not.toHaveProperty('agent_control.service_name')
      expect(hints[0]).not.toHaveProperty('agent_control.environment')
      expect(hints[0]?.['agent_control.service_version']).toBe('abc123')
    })

    it('reports once per process per variable, however many requests call it', async () => {
      useLocalVariables()
      const control = new AgentControl('checkout')
      const hints = await collectHints(async () => {
        const resolution = await control.resolution()
        control.reportBaseline(baseline, resolution)
        control.reportBaseline(baseline, resolution)
        new AgentControl('checkout').reportBaseline(baseline, resolution)
      })
      expect(hints).toHaveLength(1)
    })

    it('reports again once the process is pointed at a second project', async () => {
      // The guard is keyed on the destination, not on the variable's name alone: a process serving
      // two Logfire projects has to report the agent to each, or the second project never learns
      // about an agent the first one happened to see first.
      useLocalVariables()
      const first = await reported(new AgentControl('checkout'))
      useLocalVariables()
      const second = await reported(new AgentControl('checkout'))
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
    })

    it('reports a configured agent too, and says so', async () => {
      // An agent that reported only while unconfigured would go quiet the moment someone configured
      // it, and its stored baseline would describe the code as it was that day.
      useLocalVariables(publishedValue('agent__checkout', { model: 'anthropic:claude-fable-5-1' }))
      const hints = await reported(new AgentControl('checkout', { label: 'production' }))
      expect(hints[0]?.['agent_control.resolution_reason']).toBe('resolved')
      // Still the *code* baseline, not the managed value that is overriding it.
      expect(hints[0]?.['agent_control.baseline_sha256']).toBe(BASELINE_SHA256)
    })

    describe('the reporting budget', () => {
      /** Tool definitions that together push a baseline past the 1 MiB budget. */
      function manyTools(count: number): ToolDef[] {
        return Array.from({ length: count }, (_unused, index) => ({
          name: `tool_${String(index)}`,
          description: 'x'.repeat(200),
          parametersJsonSchema: {},
        }))
      }

      it('drops whole tool definitions rather than cutting the JSON mid-string', async () => {
        // The backend truncates a long attribute in place, which for JSON is a string that still
        // looks like one and no longer parses. What comes off the span is always a whole document.
        useLocalVariables()
        const oversize = buildBaseline({
          instructions: [{ id: 'agent', text: 'You are a checkout assistant.', dynamic: false }],
          tools: manyTools(6000),
        })
        const hints = await reported(new AgentControl('checkout'), oversize)
        expect(hints[0]?.['agent_control.baseline_reduction']).toBe('tool_definitions')
        const carried = hints[0]?.['agent_control.baseline'] as string
        expect(JSON.parse(carried)).toEqual({
          instructions: [{ id: 'agent', instructions: 'You are a checkout assistant.', dynamic: false }],
        })
        // The size is the whole baseline's, before the reduction, so a consumer can threshold on what
        // the agent actually says rather than on what survived.
        expect(hints[0]?.['agent_control.baseline_bytes']).toBeGreaterThan(Buffer.byteLength(carried))
      })

      it('omits a baseline that is too large even without its tool definitions', async () => {
        useLocalVariables()
        const huge = buildBaseline({
          instructions: [{ id: 'agent', text: 'x'.repeat(2 * 1024 * 1024), dynamic: false }],
          tools: manyTools(10),
        })
        const hints = await reported(new AgentControl('checkout'), huge)
        expect(hints[0]?.['agent_control.baseline_reduction']).toBe('omitted')
        expect(hints[0]).not.toHaveProperty('agent_control.baseline')
        // Still says how big it was, and still digests it: the two facts a consumer has left.
        expect(hints[0]?.['agent_control.baseline_bytes']).toBeGreaterThan(2 * 1024 * 1024)
        expect(hints[0]?.['agent_control.baseline_sha256']).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/u))
      })

      it('digests the whole baseline, not the JSON that survived', async () => {
        // Two oversize reports of *different* code have to differ, and the digest is the only thing
        // left to tell them apart by. A digest taken after the reduction would make this agent --
        // which advertises 6000 tools -- indistinguishable from one that advertises none.
        useLocalVariables()
        const instructions = [{ id: 'agent', text: 'You are a checkout assistant.', dynamic: false }]
        const oversize = await reported(new AgentControl('checkout'), buildBaseline({ instructions, tools: manyTools(6000) }))
        resetProcessState()
        const survivor = await reported(new AgentControl('checkout'), buildBaseline({ instructions }))
        expect(oversize[0]?.['agent_control.baseline_reduction']).toBe('tool_definitions')
        // What each span carries is the same document; what each agent *is* is not.
        expect(oversize[0]?.['agent_control.baseline']).toBe(survivor[0]?.['agent_control.baseline'])
        expect(oversize[0]?.['agent_control.baseline_sha256']).not.toBe(survivor[0]?.['agent_control.baseline_sha256'])
      })
    })

    describe('how much of the baseline is reported', () => {
      it('reports every seam and no text under `structure`', async () => {
        useLocalVariables()
        const full = buildBaseline({
          instructions: [
            { id: 'agent', text: 'You are a checkout assistant.', dynamic: false },
            { id: 'today', text: '', dynamic: true },
          ],
          model: 'openai:gpt-5.6-sol',
          settings: { temperature: 0.2 },
          tools: [
            {
              name: 'refund',
              description: 'Refund an order for a named customer.',
              parametersJsonSchema: { properties: { order_id: { description: 'The order to refund.' } } },
              toolset: 'billing',
            },
          ],
        })
        const hints = await reported(new AgentControl('checkout', { reportBaseline: 'structure' }), full)
        expect(JSON.parse(hints[0]?.['agent_control.baseline'] as string)).toEqual({
          // Every id an override can address, and the `dynamic` flag that says which of them are not
          // addressable, with none of the prose.
          instructions: [
            { id: 'agent', dynamic: false },
            { id: 'today', dynamic: true },
          ],
          model: 'openai:gpt-5.6-sol',
          settings: { temperature: 0.2 },
          tool_definitions: [{ name: 'refund', parameters: { order_id: {} }, toolset: 'billing' }],
        })
        // The digest and the size describe what was reported, so two deployments running the same
        // code under the same policy still agree, and a consumer's check of the one against the
        // other still holds.
        expect(hints[0]?.['agent_control.baseline_reduction']).toBe('none')
      })

      it('holds an observed baseline to its seams by default, and a code one to its text', async () => {
        // Code-side text is the author's, written knowing it is editable from this Logfire project.
        // Text snapshotted from a request is whoever's request it happened to be.
        useLocalVariables()
        const observed = await reported(new AgentControl('checkout'), baseline, { source: 'observed' })
        expect(observed[0]?.['agent_control.baseline_source']).toBe('observed')
        expect(JSON.parse(observed[0]?.['agent_control.baseline'] as string)).toEqual({
          instructions: [{ id: 'agent', dynamic: false }],
          model: 'openai:gpt-5.6-sol',
        })

        resetProcessState()
        const code = await reported(new AgentControl('checkout'))
        expect(code[0]?.['agent_control.baseline']).toBe(JSON.stringify(baseline, null, 2))
      })

      it('still reports an observed baseline in full when the deployment asks for it', async () => {
        useLocalVariables()
        const hints = await reported(new AgentControl('checkout', { reportBaseline: 'text' }), baseline, { source: 'observed' })
        expect(hints[0]?.['agent_control.baseline']).toBe(JSON.stringify(baseline, null, 2))
      })

      it('reports the agent without its baseline under `off`', async () => {
        // The agent still registers and is still told apart from another one by its digest; only the
        // document stays in the process. It lands in the same state an oversize baseline does,
        // because a second word for "the document is not here" would only be a second thing to learn.
        useLocalVariables()
        const hints = await reported(new AgentControl('checkout', { reportBaseline: 'off' }))
        expect(hints[0]).not.toHaveProperty('agent_control.baseline')
        expect(hints[0]?.['agent_control.baseline_reduction']).toBe('omitted')
        expect(hints[0]?.['agent_control.baseline_sha256']).toBe(BASELINE_SHA256)
        expect(hints[0]?.['agent_control.baseline_bytes']).toBe(171)
      })
    })

    it('names the framework the adapter gave it', async () => {
      // The ids a baseline addresses its instruction blocks by are each implementation's own, so a
      // consumer has to know whose baseline it is reading.
      useLocalVariables()
      const hints = await reported(new AgentControl('checkout', { framework: 'mastra' }))
      expect(hints[0]?.['agent_control.framework']).toBe('mastra')
    })

    it('digests the same document the Python core does', async () => {
      // `JSON.stringify` emits non-ASCII and `json.dumps` escapes it by default, so without
      // `ensure_ascii=False` on that side the first instruction block with an accent in it would give
      // two identical baselines two different digests. This literal is
      // `hashlib.sha256(json.dumps(document, sort_keys=True, separators=(',', ':'),
      // ensure_ascii=False).encode()).hexdigest()` over the same document.
      useLocalVariables()
      const accented = buildBaseline({
        instructions: [{ id: 'agent', text: 'Grüße, ¿cómo estás?', dynamic: false }],
        model: 'openai:gpt-5.6-sol',
      })
      const hints = await reported(new AgentControl('checkout'), accented)
      expect(hints[0]?.['agent_control.baseline_sha256']).toBe('c629a0aa59c85031af9c51e5e4dae698d010f825d5d17cc9fad16f5fc7bf7c5e')
    })

    it('survives a raised minimum level, because a hint is a span and not a log', async () => {
      // A log below the configured minimum is dropped, and a signal the platform contract depends on
      // cannot be something a logging setting silently withholds.
      useLocalVariables()
      configureLogfireApi({ minLevel: 'error' })
      try {
        expect(await reported(new AgentControl('checkout'))).toHaveLength(1)
      } finally {
        configureLogfireApi({ minLevel: null })
      }
    })

    it('warns once and never throws when the baseline will not serialize', async () => {
      // Reporting happens in the middle of an agent run. An adapter that assembled an `AgentConfig`
      // itself can hand in a value `JSON.stringify` refuses, and the run has to keep running.
      useLocalVariables()
      const circular: Record<string, unknown> = {}
      circular['self'] = circular
      const hints = await reported(new AgentControl('checkout'), { settings: circular })
      expect(hints).toEqual([])
      expect(warnings.messages).toEqual([
        "Failed to report the code baseline for Logfire managed variable 'agent__checkout': " +
          'Converting circular structure to JSON\n' +
          "    --> starting at object with constructor 'Object'\n" +
          "    --- property 'self' closes the circle",
      ])
    })
  })
})
describe('report', () => {
  const unknownTool: ApplyIssue = {
    section: 'tool_definitions',
    reason: 'unknown-tool',
    tool: 'refund',
    message: "Managed agent config patches tool 'refund', which no toolset advertises for this request.",
  }
  const unknownSetting: ApplyIssue = {
    section: 'settings',
    reason: 'unknown-setting',
    setting: 'service_tier',
    message: "Managed agent config sets 'service_tier', which this SDK has no model setting for.",
  }

  it('applies the policy to every section at once', () => {
    new AgentControl('checkout').report(unknownTool, unknownSetting)
    expect(warnings.messages).toEqual([unknownTool.message, unknownSetting.message])
  })

  it('throws once naming every issue, rather than on the first', () => {
    // The defect this replaces: `'error'` threw inside the first section's apply call, so the other
    // sections were never planned and the strictest policy reported the least.
    const control = new AgentControl('checkout', { onUnmatched: 'error' })
    let thrown: unknown
    try {
      control.report(unknownTool, unknownSetting)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UnmatchedConfigError)
    // Carried, so an adapter can raise its own framework's error type without restating a message.
    expect((thrown as UnmatchedConfigError).message).toBe(`${unknownTool.message}\n${unknownSetting.message}`)
    expect((thrown as UnmatchedConfigError).issues).toEqual([unknownTool, unknownSetting])
  })

  it('says nothing under ignore, and nothing at all for a request with no issues', () => {
    new AgentControl('checkout', { onUnmatched: 'ignore' }).report(unknownTool)
    new AgentControl('checkout', { onUnmatched: 'error' }).report()
    expect(warnings.messages).toEqual([])
  })

  it('still takes a message with no path to give', () => {
    new AgentControl('checkout').reportUnmatched('Managed agent config selects a model this framework cannot switch.')
    expect(warnings.messages).toEqual(['Managed agent config selects a model this framework cannot switch.'])
    expect(() => {
      new AgentControl('checkout', { onUnmatched: 'error' }).reportUnmatched('nope')
    }).toThrow(UnmatchedConfigError)
  })
})
