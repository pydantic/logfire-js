import { describe, expect, it } from 'vite-plus/test'

import { applyInstructions, instructionEntries, MAX_MODEL_FACING_TEXT_LENGTH, UnmatchedConfigError } from '../index'
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
    it('warns and keeps what the code produces', () => {
      const { blocks: result } = applyInstructions(codeBlocks, {
        instructions: [{ id: 'capability:clock', instructions: 'Today is never.' }],
      })
      expect(result).toEqual(codeBlocks)
      expect(warnings.messages).toHaveLength(1)
      expect(warnings.messages[0]).toContain("addresses instruction block 'capability:clock', which the agent recomputes")
    })

    it('is not reported a second time as a key nothing carries', () => {
      applyInstructions(codeBlocks, { instructions: [{ id: 'capability:clock' }] })
      expect(warnings.messages).toHaveLength(1)
      expect(warnings.messages[0]).not.toContain('does not assemble')
    })
  })

  describe('onUnmatched', () => {
    const config = { instructions: [{ id: 'toolset:gone', instructions: 'Never seen.' }] }

    it("warns by default, once per process, because another deployment's config may be right", () => {
      applyInstructions(codeBlocks, config)
      applyInstructions(codeBlocks, config)
      expect(warnings.messages).toEqual([
        "Managed agent config addresses instruction block 'toolset:gone', which this request does not " +
          'assemble; that entry applies to nothing.',
      ])
    })

    it('says nothing under ignore', () => {
      applyInstructions(codeBlocks, config, { onUnmatched: 'ignore' })
      expect(warnings.messages).toEqual([])
    })

    it('fails the run under error, with the message the warning would have carried', () => {
      expect(() => applyInstructions(codeBlocks, config, { onUnmatched: 'error' })).toThrow(UnmatchedConfigError)
      expect(() => applyInstructions(codeBlocks, config, { onUnmatched: 'error' })).toThrow(
        /addresses instruction block 'toolset:gone', which this request does not assemble/u
      )
    })

    it('governs the dynamic case too', () => {
      expect(() => applyInstructions(codeBlocks, { instructions: [{ id: 'capability:clock' }] }, { onUnmatched: 'error' })).toThrow(
        /which the agent recomputes per request/u
      )
    })
  })

  it('keeps the first of two entries naming the same id', () => {
    const { blocks: result } = applyInstructions(codeBlocks, {
      instructions: [
        { id: 'agent', instructions: 'First wins.' },
        { id: 'agent', instructions: 'Second loses.' },
      ],
    })
    expect(result[0]?.text).toBe('First wins.')
    expect(warnings.messages[0]).toContain("names instruction id 'agent' more than once")
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
    const { unapplied } = applyInstructions(
      codeBlocks,
      { instructions: [{ id: 'toolset:gone', instructions: 'Never seen.' }, { id: 'capability:clock' }] },
      { onUnmatched: 'ignore' }
    )
    expect(unapplied.map((entry) => [entry.reason, entry.instructionId])).toEqual([
      ['dynamic-id', 'capability:clock'],
      ['unknown-id', 'toolset:gone'],
    ])
  })

  it('refuses text past the budget rather than truncating it', () => {
    // Half a prompt is not a smaller version of the prompt. The parser caps a published value, so
    // reaching here means an adapter built the config itself -- and the answer is the same.
    const oversized = 'a'.repeat(MAX_MODEL_FACING_TEXT_LENGTH + 1)
    const { blocks, unapplied } = applyInstructions(
      codeBlocks,
      { instructions: [{ id: 'agent', instructions: oversized }, oversized] },
      { onUnmatched: 'ignore' }
    )
    expect(blocks).toEqual(codeBlocks)
    expect(unapplied.map((entry) => [entry.reason, entry.instructionId])).toEqual([
      ['oversized-text', 'agent'],
      ['oversized-text', undefined],
    ])
    expect(unapplied[0]?.message).toContain("for instruction block 'agent'")
    expect(unapplied[1]?.message).not.toContain('for instruction block')
  })

  it('measures that budget in code points, the way the contract counts text', () => {
    // An astral character is one code point and two UTF-16 units; counting units would put this
    // exactly at twice the budget in one core and inside it in the other.
    const atBudget = '\u{1D11E}'.repeat(MAX_MODEL_FACING_TEXT_LENGTH)
    const { unapplied } = applyInstructions([], { instructions: [atBudget] }, { onUnmatched: 'ignore' })
    expect(unapplied).toEqual([])
  })

  it('reports nothing, and copies the blocks, when the config touches instructions at all', () => {
    const { blocks, unapplied } = applyInstructions(codeBlocks, { model: 'openai:gpt-5.6-sol' })
    expect(blocks).toEqual(codeBlocks)
    expect(blocks).not.toBe(codeBlocks)
    expect(unapplied).toEqual([])
  })
})
