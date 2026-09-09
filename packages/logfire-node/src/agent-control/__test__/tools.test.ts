import { describe, expect, it } from 'vite-plus/test'

import { applyToolDefinitions, toolKey, UnmatchedConfigError, withParameterDescriptions } from '../index'
import type { ToolDef } from '../index'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

const codeTools: ToolDef[] = [
  {
    name: 'search',
    description: 'Search the CRM.',
    parametersJsonSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Query.' }, limit: { type: 'integer' } },
      required: ['q'],
    },
    toolset: 'crm',
  },
  {
    name: 'search',
    description: 'Search the docs.',
    parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
    toolset: 'docs',
  },
  {
    name: 'refund',
    description: 'Issue a refund.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
]

describe('applyToolDefinitions', () => {
  it('leaves the tools alone and still routes every one of them', () => {
    const { tools, routes } = applyToolDefinitions(codeTools, {})
    expect(tools).toEqual(codeTools)
    expect(routes).toEqual({ search: 'search', refund: 'refund' })
    expect(warnings.messages).toEqual([])
  })

  it('patches description and parameter descriptions without touching the rest of the schema', () => {
    const { tools } = applyToolDefinitions(codeTools, {
      tool_definitions: [
        { name: 'refund', description: 'Refund the customer, once approved.' },
        {
          name: 'search',
          toolset: 'crm',
          parameters: { q: { description: 'A customer name or email.' } },
        },
      ],
    })
    expect(tools[2]?.description).toBe('Refund the customer, once approved.')
    expect(tools[0]?.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        q: { type: 'string', description: 'A customer name or email.' },
        limit: { type: 'integer' },
      },
      required: ['q'],
    })
    // Requiredness, types, and every other parameter are code-owned and untouched.
    expect(tools[1]?.parametersJsonSchema).toBe(codeTools[1]?.parametersJsonSchema)
  })

  it('narrows a match to one toolset, letting two tools of the same name be patched apart', () => {
    const { tools } = applyToolDefinitions(codeTools, {
      tool_definitions: [
        { name: 'search', toolset: 'crm', description: 'CRM search.' },
        { name: 'search', toolset: 'docs', description: 'Docs search.' },
      ],
    })
    expect(tools.map((tool) => tool.description)).toEqual(['CRM search.', 'Docs search.', 'Issue a refund.'])
  })

  it('lets a qualified override beat an unqualified one, without reporting the loser as unmatched', () => {
    const { tools } = applyToolDefinitions(codeTools, {
      tool_definitions: [
        { name: 'search', description: 'Every search.' },
        { name: 'search', toolset: 'crm', description: 'The CRM search.' },
      ],
    })
    expect(tools.map((tool) => tool.description)).toEqual(['The CRM search.', 'Every search.', 'Issue a refund.'])
    expect(warnings.messages).toEqual([])
  })

  it('renames a tool and routes the new name back to the code-side one', () => {
    const { tools, routes } = applyToolDefinitions(codeTools, {
      tool_definitions: [{ name: 'refund', new_name: 'issue_refund' }],
    })
    expect(tools[2]?.name).toBe('issue_refund')
    // Keyed by what the model is shown, so a call is routed by the name the model actually used.
    expect(routes).toEqual({ search: 'search', issue_refund: 'refund' })
  })

  it('reports a patch on a parameter the tool does not have, rather than ignoring it', () => {
    const { tools, unapplied } = applyToolDefinitions(codeTools, {
      tool_definitions: [{ name: 'refund', parameters: { nonexistent: { description: 'Nothing.' } } }],
    })
    expect(tools[2]).toBe(codeTools[2])
    // From the Logfire UI, a patch naming a parameter the tool does not have looked exactly like one
    // that applied, which is the whole reason this is not silent.
    expect(unapplied).toEqual([
      {
        reason: 'unknown-parameter',
        toolset: null,
        tool: 'refund',
        parameter: 'nonexistent',
        message:
          "Managed agent config patches parameter 'nonexistent' of tool 'refund', which has no parameter " +
          'of that name; that patch applies to nothing.',
      },
    ])
    expect(warnings.messages).toEqual([unapplied[0]?.message])
  })

  describe('a rename onto a taken name', () => {
    it("is dropped, with the override's other patches kept", () => {
      const { tools, routes } = applyToolDefinitions(codeTools, {
        tool_definitions: [{ name: 'refund', new_name: 'search', description: 'Still applied.' }],
      })
      expect(tools[2]).toEqual({ ...codeTools[2], description: 'Still applied.' })
      expect(routes).toEqual({ search: 'search', refund: 'refund' })
      expect(warnings.messages[0]).toBe(
        "Managed tool definition override renames 'refund' to 'search', which is already advertised by " +
          "another tool; keeping the original name 'refund'."
      )
    })

    it('is dropped when the collision is with a name an earlier rename produced', () => {
      const { tools } = applyToolDefinitions(codeTools, {
        tool_definitions: [
          { name: 'search', toolset: 'crm', new_name: 'lookup' },
          { name: 'refund', new_name: 'lookup' },
        ],
      })
      expect(tools.map((tool) => tool.name)).toEqual(['lookup', 'search', 'refund'])
      expect(warnings.messages[0]).toContain("renames 'refund' to 'lookup'")
    })

    it('leaves every tool reachable under a callable name', () => {
      const { tools, routes } = applyToolDefinitions(codeTools, {
        tool_definitions: [{ name: 'refund', new_name: 'search' }],
      })
      for (const tool of tools) {
        expect(routes[tool.name]).toBeDefined()
      }
    })
  })

  describe('onUnmatched', () => {
    const config = {
      tool_definitions: [{ name: 'search', toolset: 'billing', description: 'Elsewhere.' }],
    }

    it('warns by default, naming the toolset the entry was narrowed to', () => {
      applyToolDefinitions(codeTools, config)
      expect(warnings.messages).toEqual([
        "Managed agent config patches tool 'search' from toolset 'billing', which no toolset advertises " +
          'for this request; that override applies to nothing.',
      ])
    })

    it('names an unqualified entry without a toolset', () => {
      applyToolDefinitions(codeTools, { tool_definitions: [{ name: 'nonexistent' }] })
      expect(warnings.messages[0]).toContain("patches tool 'nonexistent', which no toolset advertises")
    })

    it('says nothing under ignore', () => {
      applyToolDefinitions(codeTools, config, { onUnmatched: 'ignore' })
      expect(warnings.messages).toEqual([])
    })

    it('fails the run under error', () => {
      expect(() => applyToolDefinitions(codeTools, config, { onUnmatched: 'error' })).toThrow(UnmatchedConfigError)
    })
  })

  it('keeps the first of two overrides with the same name and toolset', () => {
    const { tools } = applyToolDefinitions(codeTools, {
      tool_definitions: [
        { name: 'refund', description: 'First wins.' },
        { name: 'refund', description: 'Second loses.' },
      ],
    })
    expect(tools[2]?.description).toBe('First wins.')
    expect(warnings.messages[0]).toContain("names tool 'refund' more than once")
  })

  it('matches a tool with no toolset against an unqualified override only', () => {
    const { tools } = applyToolDefinitions(codeTools, {
      tool_definitions: [{ name: 'refund', toolset: 'crm', description: 'Wrong toolset.' }],
    })
    expect(tools[2]?.description).toBe('Issue a refund.')
    expect(warnings.messages[0]).toContain("patches tool 'refund' from toolset 'crm'")
  })
})

describe('withParameterDescriptions', () => {
  it('returns the same object when there is nothing to patch', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } }
    expect(withParameterDescriptions(schema, {})).toBe(schema)
    expect(withParameterDescriptions(schema, { q: {} })).toBe(schema)
  })

  it('returns the same object for a schema with no properties to patch', () => {
    const schema = { type: 'string' }
    expect(withParameterDescriptions(schema, { q: { description: 'x' } })).toBe(schema)
  })

  it('leaves a non-object property entry alone', () => {
    const schema = { type: 'object', properties: { q: 'not a schema' } }
    expect(withParameterDescriptions(schema, { q: { description: 'x' } })).toBe(schema)
  })
})

describe('routing identity', () => {
  it('maps both directions on the `(toolset, name)` pair, not on a bare name', () => {
    const { forward, reverse, routes } = applyToolDefinitions(codeTools, {
      tool_definitions: [{ name: 'search', toolset: 'docs', new_name: 'lookup' }],
    })
    // Out: the name the code gave a tool, to the name it is advertised under.
    expect(forward.get(toolKey('crm', 'search'))).toBe('search')
    expect(forward.get(toolKey('docs', 'search'))).toBe('lookup')
    // In: the name a call arrives under, back to the tool the code defined.
    expect(reverse.get(toolKey('docs', 'lookup'))).toBe('search')
    expect(reverse.get(toolKey(null, 'refund'))).toBe('refund')
    // The flat table keeps the first of two tools advertising one name, which is why an adapter that
    // allows that reads `reverse` instead.
    expect(routes['search']).toBe('search')
  })

  it('reserves names the adapter needs kept free, so a rename cannot take a handoff', () => {
    const { tools, unapplied } = applyToolDefinitions(
      codeTools,
      { tool_definitions: [{ name: 'refund', new_name: 'transfer_to_billing', description: 'Still applied.' }] },
      { reserved: ['transfer_to_billing'] }
    )
    expect(tools[2]?.name).toBe('refund')
    expect(tools[2]?.description).toBe('Still applied.')
    expect(unapplied.map((entry) => entry.reason)).toEqual(['rename-collision'])
  })

  it("lets two toolsets each answer to a name when that is what the framework's runtime names mean", () => {
    // The Claude Agent SDK advertises `mcp__<server>__<tool>`, so renaming the CRM's `search` to
    // `lookup` cannot collide with the docs toolset's `lookup`: they are different runtime names.
    const tools: ToolDef[] = [
      { name: 'search', parametersJsonSchema: {}, toolset: 'crm' },
      { name: 'lookup', parametersJsonSchema: {}, toolset: 'docs' },
      // A tool with no toolset competes in its own namespace, the one keyed on nothing.
      { name: 'refund', parametersJsonSchema: {} },
    ]
    const scoped = applyToolDefinitions(
      tools,
      { tool_definitions: [{ name: 'search', toolset: 'crm', new_name: 'lookup' }] },
      { collisionScope: 'toolset' }
    )
    expect(scoped.tools.map((tool) => tool.name)).toEqual(['lookup', 'lookup', 'refund'])
    expect(scoped.unapplied).toEqual([])
    expect(scoped.reverse.get(toolKey('crm', 'lookup'))).toBe('search')

    // Under the default global scope the same rename is a genuine collision.
    const global = applyToolDefinitions(tools, {
      tool_definitions: [{ name: 'search', toolset: 'crm', new_name: 'lookup' }],
    })
    expect(global.tools.map((tool) => tool.name)).toEqual(['search', 'lookup', 'refund'])
    expect(global.unapplied.map((entry) => entry.reason)).toEqual(['rename-collision'])
  })

  it('is a table about this request, not about `Object.prototype`', () => {
    // A tool the model calls `constructor` must be a name `routes` does not have, rather than an
    // inherited function an adapter would go on to invoke.
    const { routes } = applyToolDefinitions([{ name: 'refund', parametersJsonSchema: {} }], {})
    expect('constructor' in routes).toBe(false)
    expect('toString' in routes).toBe(false)
  })
})

describe('a rename collision goes through onUnmatched like every other decision', () => {
  const config = { tool_definitions: [{ name: 'refund', new_name: 'search' }] }

  it('says nothing under ignore', () => {
    // It used to warn unconditionally, so `'ignore'` still warned and `'error'` did not fail.
    applyToolDefinitions(codeTools, config, { onUnmatched: 'ignore' })
    expect(warnings.messages).toEqual([])
  })

  it('fails the run under error', () => {
    expect(() => applyToolDefinitions(codeTools, config, { onUnmatched: 'error' })).toThrow(UnmatchedConfigError)
  })
})

describe('a parameter patch that reaches nothing', () => {
  it('reports a tool with no top-level parameters to patch at all', () => {
    const { unapplied } = applyToolDefinitions(
      [{ name: 'raw', parametersJsonSchema: { type: 'string' } }],
      { tool_definitions: [{ name: 'raw', parameters: { q: { description: 'Query.' } } }] },
      { onUnmatched: 'ignore' }
    )
    expect(unapplied).toEqual([
      {
        reason: 'no-patchable-schema',
        toolset: null,
        tool: 'raw',
        parameter: 'q',
        message:
          "Managed agent config patches parameter 'q' of tool 'raw', which has no top-level parameters; " +
          'that patch applies to nothing.',
      },
    ])
  })

  it('reports a parameter whose schema is not an object to patch a description into', () => {
    const { unapplied } = applyToolDefinitions(
      [{ name: 'odd', parametersJsonSchema: { type: 'object', properties: { flag: true } } }],
      { tool_definitions: [{ name: 'odd', parameters: { flag: { description: 'On or off.' } } }] },
      { onUnmatched: 'ignore' }
    )
    expect(unapplied.map((entry) => [entry.reason, entry.parameter])).toEqual([['no-patchable-schema', 'flag']])
  })

  it('fails the run under error, which it could not do while it was silent', () => {
    expect(() =>
      applyToolDefinitions(codeTools, { tool_definitions: [{ name: 'refund', parameters: { nonexistent: {} } }] }, { onUnmatched: 'error' })
    ).toThrow(UnmatchedConfigError)
  })

  it('says nothing about a parameter entry that asks for no change', () => {
    const { unapplied } = applyToolDefinitions(codeTools, {
      tool_definitions: [{ name: 'search', toolset: 'crm', parameters: { q: {} } }],
    })
    expect(unapplied).toEqual([])
  })
})
