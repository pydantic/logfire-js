import { describe, expect, it } from 'vite-plus/test'

import { buildBaseline } from '../index'
import type { InstructionBlock, ToolDef } from '../index'
import { captureWarnings } from './helpers'

captureWarnings()

const blocks: InstructionBlock[] = [
  { id: 'agent', text: 'You are a checkout assistant.', dynamic: false },
  { id: null, text: 'An unaddressable contribution.', dynamic: false },
  { id: 'capability:clock', text: 'Today is 2026-09-09, and the user is u_8812.', dynamic: true },
]

const tools: ToolDef[] = [
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
]

describe('buildBaseline', () => {
  it('describes the agent as written, in contract order and with nothing unset', () => {
    const baseline = buildBaseline({
      instructions: blocks,
      model: 'anthropic:claude-fable-5-1',
      settings: { temperature: 0.2, max_tokens: 1024 },
      tools,
    })
    // The exact bytes that become the variable's `example`, which is what the Logfire editor shows
    // as the thing a managed value is layered onto.
    expect(JSON.stringify(baseline, null, 2)).toMatchInlineSnapshot(`
      "{
        "instructions": [
          {
            "id": "agent",
            "instructions": "You are a checkout assistant.",
            "dynamic": false
          },
          {
            "instructions": "An unaddressable contribution.",
            "dynamic": false
          },
          {
            "id": "capability:clock",
            "dynamic": true
          }
        ],
        "model": "anthropic:claude-fable-5-1",
        "settings": {
          "max_tokens": 1024,
          "temperature": 0.2
        },
        "tool_definitions": [
          {
            "name": "search",
            "description": "Search the CRM.",
            "parameters": {
              "q": {
                "description": "Query."
              },
              "limit": {}
            },
            "toolset": "crm"
          }
        ]
      }"
    `)
  })

  it("publishes a dynamic block's seam and never its text", () => {
    const baseline = buildBaseline({ instructions: blocks })
    const serialized = JSON.stringify(baseline)
    expect(serialized).not.toContain('u_8812')
    expect(serialized).toContain('{"id":"capability:clock","dynamic":true}')
  })

  it('drops a dynamic block nothing can address, which has neither an address nor safe text', () => {
    const baseline = buildBaseline({
      instructions: [{ id: null, text: 'Computed.', dynamic: true }],
    })
    expect(baseline.instructions).toBeUndefined()
  })

  it('drops a blank static block, which has nothing to describe', () => {
    const baseline = buildBaseline({
      instructions: [{ id: 'agent', text: '  \n ', dynamic: false }],
    })
    expect(baseline.instructions).toBeUndefined()
  })

  it('publishes the seam of a dynamic block whose text the adapter could not read', () => {
    // A framework that renders its dynamic instructions inside a binary -- Codex, the Claude Agent
    // SDK -- can name the block and nothing else, so it passes an empty `text`. That text was never
    // going to be published anyway, which is why blankness must not cost the block its seam:
    // dropping it erases from the baseline the one block the editor has no other way to learn about.
    const baseline = buildBaseline({
      instructions: [
        { id: 'agent', text: 'You are a checkout assistant.', dynamic: false },
        { id: 'harness:system', text: '', dynamic: true },
      ],
    })
    expect(baseline.instructions).toEqual([
      { id: 'agent', instructions: 'You are a checkout assistant.', dynamic: false },
      { id: 'harness:system', dynamic: true },
    ])
  })

  it('filters settings to the canonical keys, keeping provider secrets out of a shared variable', () => {
    const baseline = buildBaseline({
      settings: {
        temperature: 0.2,
        extra_headers: { authorization: 'Bearer sk-secret' },
        top_k: null,
      },
    })
    expect(baseline.settings).toEqual({ temperature: 0.2 })
    expect(JSON.stringify(baseline)).not.toContain('sk-secret')
  })

  it('omits a section with nothing in it, rather than publishing an empty one', () => {
    expect(buildBaseline({})).toEqual({})
    expect(buildBaseline({ instructions: [], model: null, settings: null, tools: [] })).toEqual({})
    expect(buildBaseline({ settings: {} })).toEqual({})
  })

  it('reports a tool with no description, no parameters, and no toolset as just its name', () => {
    const baseline = buildBaseline({
      tools: [{ name: 'ping', description: '', parametersJsonSchema: { type: 'object', properties: {} } }],
    })
    expect(baseline.tool_definitions).toEqual([{ name: 'ping' }])
  })

  it('lists every top-level parameter, so an undocumented one can be described from Logfire', () => {
    const baseline = buildBaseline({
      tools: [
        {
          name: 'a',
          parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
        { name: 'b', parametersJsonSchema: { type: 'string' } },
        { name: 'c', parametersJsonSchema: { type: 'object', properties: { q: 'not a schema' } } },
      ],
    })
    // `a`'s `q` and `c`'s `q` carry an empty entry rather than being left out: an undocumented
    // parameter is exactly the one somebody wants to describe from Logfire, and a baseline listing
    // only the documented ones would hide it until it had been documented in code first. `b` has no
    // `properties` object at all, which is not a parameter list to guess at.
    expect(baseline.tool_definitions).toEqual([{ name: 'a', parameters: { q: {} } }, { name: 'b' }, { name: 'c', parameters: { q: {} } }])
  })

  it('round-trips through the helpers it feeds, so a baseline is a config an override can address', () => {
    const baseline = buildBaseline({ instructions: blocks, tools })
    const ids = (baseline.instructions as { id?: string }[]).map((entry) => entry.id)
    expect(ids).toEqual(['agent', undefined, 'capability:clock'])
  })
})
