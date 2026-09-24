import { describe, expect, it } from 'vite-plus/test'

import { applyInstructions, instructionEntries, MAX_MODEL_FACING_TEXT_LENGTH, parseAgentConfig } from '../index'
import type { InstructionBlock } from '../index'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

const codeBlocks: InstructionBlock[] = [
  { id: 'agent', text: 'You are a checkout assistant.', dynamic: false },
  { id: 'toolset:crm', text: 'Use the CRM tools.', dynamic: false },
  { id: null, text: 'Anonymous contribution.', dynamic: false },
  { id: 'capability:clock', text: 'Today is 2026-09-09.', dynamic: true },
]

describe('applyInstructions', () => {
  it('leaves every block alone when nothing is published', () => {
    expect(applyInstructions(codeBlocks, {}).blocks).toEqual(codeBlocks)
    expect(warnings.messages).toEqual([])
  })

  it('replaces an addressed block in place, keeping its position and dynamic flag', () => {
    const { blocks: result } = applyInstructions(codeBlocks, {
      instructions: [{ id: 'toolset:crm', instructions: 'Use the CRM tools sparingly.' }],
    })
    expect(result).toEqual([
      codeBlocks[0],
      { id: 'toolset:crm', text: 'Use the CRM tools sparingly.', dynamic: false },
      codeBlocks[2],
      codeBlocks[3],
    ])
  })

  it('drops an addressed block when the entry publishes no text', () => {
    const { blocks: result } = applyInstructions(codeBlocks, { instructions: [{ id: 'agent' }] })
    expect(result.map((block) => block.id)).toEqual(['toolset:crm', null, 'capability:clock'])
  })

  it('adds a block after the last static one and before the first dynamic one', () => {
    const { blocks: result } = applyInstructions(codeBlocks, { instructions: 'Answer in French.' })
    expect(result.map((block) => block.text)).toEqual([
      'You are a checkout assistant.',
      'Use the CRM tools.',
      'Anonymous contribution.',
      'Answer in French.',
      'Today is 2026-09-09.',
    ])
    // New text, addressable by nothing, and fixed by construction -- so it cannot move the cache
    // boundary the dynamic block sits behind.
    expect(result[3]).toEqual({ id: null, text: 'Answer in French.', dynamic: false })
  })

  it('appends to the end when the agent has no dynamic blocks', () => {
    const statics = codeBlocks.slice(0, 3)
    const { blocks: result } = applyInstructions(statics, { instructions: ['One.', 'Two.'] })
    expect(result.map((block) => block.text)).toEqual([
      'You are a checkout assistant.',
      'Use the CRM tools.',
      'Anonymous contribution.',
      'One.',
      'Two.',
    ])
  })

  it('adds ahead of everything when every block is dynamic', () => {
    const { blocks: result } = applyInstructions([codeBlocks[3] as InstructionBlock], {
      instructions: 'First.',
    })
    expect(result.map((block) => block.text)).toEqual(['First.', 'Today is 2026-09-09.'])
  })

  it('gives each added entry its own block, rather than joining them', () => {
    const { blocks: result } = applyInstructions([], { instructions: ['One.', 'Two.'] })
    expect(result).toEqual([
      { id: null, text: 'One.', dynamic: false },
      { id: null, text: 'Two.', dynamic: false },
    ])
  })

  it('adds and replaces in one config without either disturbing the other', () => {
    const { blocks: result } = applyInstructions(codeBlocks, {
      instructions: [{ id: 'agent', instructions: 'You are terse.' }, 'Answer in French.'],
    })
    expect(result.map((block) => block.text)).toEqual([
      'You are terse.',
      'Use the CRM tools.',
      'Anonymous contribution.',
      'Answer in French.',
      'Today is 2026-09-09.',
    ])
  })

  describe('a dynamic block cannot be addressed', () => {
    it('keeps what the code produces and says which entry it refused', () => {
      const { blocks: result, issues } = applyInstructions(codeBlocks, {
        instructions: [{ id: 'capability:clock', instructions: 'Today is never.' }],
      })
      expect(result).toEqual(codeBlocks)
      expect(issues.map((issue) => [issue.section, issue.reason, issue.instructionId])).toEqual([
        ['instructions', 'dynamic-id', 'capability:clock'],
      ])
      expect(issues[0]?.message).toContain("addresses instruction block 'capability:clock', which the agent recomputes")
    })

    it('is not reported a second time as a key nothing carries', () => {
      const { issues } = applyInstructions(codeBlocks, { instructions: [{ id: 'capability:clock' }] })
      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).not.toContain('does not assemble')
    })
  })

  it('reports nothing itself, whatever it could not apply', () => {
    // The policy is applied once per request, by `AgentControl.report`, so that `'error'` fails on
    // everything the request got wrong rather than on whichever section was applied first.
    const { issues } = applyInstructions(codeBlocks, { instructions: [{ id: 'toolset:gone', instructions: 'x' }] })
    expect(issues).toHaveLength(1)
    expect(warnings.messages).toEqual([])
  })

  it('keeps the first of two entries naming the same id and reports the rest', () => {
    // It used to warn straight from indexing, which made `'ignore'` warn anyway and `'error'` not
    // throw at all -- the one decision the policy never governed.
    const { blocks: result, issues } = applyInstructions(codeBlocks, {
      instructions: [
        { id: 'agent', instructions: 'First wins.' },
        { id: 'agent', instructions: 'Second loses.' },
      ],
    })
    expect(result[0]?.text).toBe('First wins.')
    expect(issues.map((issue) => [issue.section, issue.reason, issue.instructionId])).toEqual([
      ['instructions', 'duplicate-entry', 'agent'],
    ])
    expect(issues[0]?.message).toContain("names instruction id 'agent' more than once")
    expect(warnings.messages).toEqual([])
  })

  it('carries a duplicate back even when nothing else is published', () => {
    // The duplicate is found while indexing, before the early return for a config that addresses no
    // block this request assembles.
    const { blocks: result, issues } = applyInstructions([], {
      instructions: [
        { id: 'agent', instructions: 'First.' },
        { id: 'agent', instructions: 'Last.' },
      ],
    })
    expect(result).toEqual([])
    expect(issues.map((issue) => issue.reason)).toEqual(['duplicate-entry', 'unknown-id'])
  })
})

describe('instructionEntries', () => {
  it('reads both shapes of the section as the same list of entries', () => {
    expect(instructionEntries({ instructions: 'One.' })).toEqual([{ instructions: 'One.' }])
    expect(instructionEntries({ instructions: ['One.', { id: 'agent' }] })).toEqual([{ instructions: 'One.' }, { id: 'agent' }])
    expect(instructionEntries({})).toEqual([])
  })
})

describe('what reached nothing comes back structured', () => {
  it('names the entry rather than leaving an adapter to parse a message', () => {
    const { issues } = applyInstructions(codeBlocks, {
      instructions: [{ id: 'toolset:gone', instructions: 'Never seen.' }, { id: 'capability:clock' }],
    })
    expect(issues.map((entry) => [entry.reason, entry.instructionId])).toEqual([
      ['dynamic-id', 'capability:clock'],
      ['unknown-id', 'toolset:gone'],
    ])
  })

  it('refuses text past the budget rather than truncating it', () => {
    // Half a prompt is not a smaller version of the prompt. The parser caps a published value, so
    // reaching here means an adapter built the config itself -- and the answer is the same.
    const oversized = 'a'.repeat(MAX_MODEL_FACING_TEXT_LENGTH + 1)
    const { blocks, issues } = applyInstructions(codeBlocks, { instructions: [{ id: 'agent', instructions: oversized }, oversized] })
    expect(blocks).toEqual(codeBlocks)
    expect(issues.map((entry) => [entry.reason, entry.instructionId])).toEqual([
      ['oversized-text', 'agent'],
      ['oversized-text', undefined],
    ])
    expect(issues[0]?.message).toContain("for instruction block 'agent'")
    expect(issues[1]?.message).not.toContain('for instruction block')
  })

  describe('and the budget is the total across entries, not a per-entry allowance', () => {
    // `parseInstructions` already charges a published value this way. A typed caller reaching
    // `applyInstructions` directly went through a per-entry check only, so two entries each at the
    // budget both applied and the request carried twice the limit.
    const half = 'a'.repeat(MAX_MODEL_FACING_TEXT_LENGTH / 2)

    it('refuses the entry that does not fit in what is left', () => {
      const { blocks, issues } = applyInstructions(codeBlocks, {
        instructions: [
          { id: 'agent', instructions: half },
          { id: 'toolset:crm', instructions: half },
          { id: 'capability:clock', instructions: 'x' },
        ],
      })
      // The first two fill the budget exactly; the third is refused for the budget, not for being
      // dynamic, because it never gets that far.
      expect(blocks[0]?.text).toBe(half)
      expect(blocks[1]?.text).toBe(half)
      expect(issues.map((entry) => [entry.reason, entry.instructionId])).toEqual([['dynamic-id', 'capability:clock']])

      const over = applyInstructions(codeBlocks, {
        instructions: [
          { id: 'agent', instructions: half },
          { id: 'toolset:crm', instructions: `${half}a` },
        ],
      })
      expect(over.blocks[0]?.text).toBe(half)
      expect(over.blocks[1]?.text).toBe('Use the CRM tools.')
      expect(over.issues.map((entry) => [entry.reason, entry.instructionId])).toEqual([['oversized-text', 'toolset:crm']])
      expect(over.issues[0]?.message).toContain('does not fit in the 32768 remaining')
    })

    it('charges added blocks against the same budget as replacements', () => {
      const { blocks, issues } = applyInstructions(codeBlocks, { instructions: [{ id: 'agent', instructions: half }, half, 'one more'] })
      expect(blocks.some((block) => block.text === 'one more')).toBe(false)
      expect(issues.map((entry) => [entry.reason, entry.instructionId])).toEqual([['oversized-text', undefined]])
    })

    it('charges in published order, so a typed config keeps what the same JSON would keep', () => {
      // Entries are *applied* replacements-first and additions-second, but `parseInstructions`
      // charges a published value in the order it was written. Charging in apply order made the two
      // disagree about which entries survive: with a 40,000-character addition published before a
      // 40,000-character replacement, the parser kept the addition and `applyInstructions` kept the
      // replacement -- the same value applying differently depending on how it reached the SDK.
      const big = 'a'.repeat(40_000)
      const config = { instructions: [big, { id: 'agent', instructions: big }] }

      const { blocks, issues } = applyInstructions(codeBlocks, config)
      expect(blocks.map((block) => block.text)).toContain(big)
      expect(blocks[0]?.text).toBe('You are a checkout assistant.')
      expect(issues.map((entry) => [entry.reason, entry.instructionId])).toEqual([['oversized-text', 'agent']])

      // The parser, given the same value, keeps the same entry.
      const parsed = parseAgentConfig(config)
      expect(parsed.instructions).toEqual([{ instructions: big }])
    })

    it('charges only the text that survives, so one refused entry does not shrink the budget', () => {
      // The refused entry adds nothing to the request, so charging it would make the entries a value
      // keeps depend on the ones it does not.
      const { blocks, issues } = applyInstructions(codeBlocks, {
        instructions: [
          { id: 'agent', instructions: 'a'.repeat(MAX_MODEL_FACING_TEXT_LENGTH + 1) },
          { id: 'toolset:crm', instructions: half },
        ],
      })
      expect(blocks[1]?.text).toBe(half)
      expect(issues.map((entry) => entry.reason)).toEqual(['oversized-text'])
    })
  })

  it('measures that budget in code points, the way the contract counts text', () => {
    // An astral character is one code point and two UTF-16 units; counting units would put this
    // exactly at twice the budget in one core and inside it in the other.
    const atBudget = '\u{1D11E}'.repeat(MAX_MODEL_FACING_TEXT_LENGTH)
    const { issues } = applyInstructions([], { instructions: [atBudget] })
    expect(issues).toEqual([])
  })

  it('reports nothing, and copies the blocks, when the config touches instructions at all', () => {
    const { blocks, issues } = applyInstructions(codeBlocks, { model: 'openai:gpt-5.6-sol' })
    expect(blocks).toEqual(codeBlocks)
    expect(blocks).not.toBe(codeBlocks)
    expect(issues).toEqual([])
  })
})
