/* eslint-disable vitest/valid-expect, vitest/no-conditional-expect -- see below */
/*
 * Every assertion in this file carries `vector.name` as its message, which is what makes a failure
 * name the rule that stopped holding rather than a line number in a loop. Vitest supports that
 * second argument to `expect`; the lint rule is modelled on Jest, which does not. The conditional
 * assertions are the vectors' own two shapes -- a name that resolves to a variable and one that has
 * no key at all -- asserted in one pass over the file, which is what "every vector in every file"
 * means.
 */
/**
 * The cross-language vectors, run against this core.
 *
 * Everything that has to give the same answer in Python and TypeScript, because a Logfire project is
 * shared and the SDKs are not: which variable an agent's config lives in, what a code baseline says,
 * what a published value parses to, and what applying one does to a request. `spec/` is where those
 * answers live, and this is the half of the agreement this package keeps. A change to a rule changes
 * the file first, and both cores after.
 *
 * The vectors are the contract, not an illustration of it: every file in `spec/` is read here and
 * every vector in it is asserted, so a rule that stops holding fails a test rather than drifting.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'

import { UNRECOGNIZED_SETTINGS } from '../config'
import {
  agentVariableName,
  applyInstructions,
  applySettings,
  applyToolDefinitions,
  buildBaseline,
  mergeSettings,
  parseAgentConfig,
} from '../index'
import type { AgentSupport, ApplyIssue, CollisionScope, InstructionBlock, ToolDef } from '../index'
import { resetWarnings } from '../warnings'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../spec')

interface Vector {
  name: string
  input: unknown
  expected?: unknown
  warnings?: string[]
  [key: string]: unknown
}

function vectors(file: string): Vector[] {
  return JSON.parse(readFileSync(path.join(SPEC, file), 'utf8')) as Vector[]
}

/**
 * Expand the vector files' `{repeat, times}` shorthand, which keeps the 64 KiB cases readable.
 *
 * Nothing about the contract depends on it: it is there so a vector about the budget is a line of
 * JSON rather than 64 KiB of one letter.
 */
function expandRepeats(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(expandRepeats)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const entries = Object.entries(value)
  if (entries.length === 2 && 'repeat' in value && 'times' in value) {
    return (value as { repeat: string }).repeat.repeat((value as { times: number }).times)
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, expandRepeats(item)]))
}

/**
 * A distinctive fragment of each warning, mapped to the code the vectors name it by.
 *
 * Both cores word their warnings for their own users; what has to match is which decision was taken,
 * which is why the vectors carry codes and this table is what turns one core's prose into them.
 * Ordered, because one fragment is a prefix of another.
 */
const CODES: [string, string][] = [
  ['selects invalid model', 'invalid-model'],
  ['Managed instructions section contains', 'instructions-section-too-long'],
  ["instructions section is invalid -- instructions=''", 'instructions-section-empty'],
  ['instructions section has invalid container', 'instructions-invalid-container'],
  ['Managed instruction entry contains', 'instruction-entry-too-long'],
  ['has neither an `id` to address nor text to add', 'instruction-entry-empty'],
  ['Managed instruction entry', 'instruction-entry-invalid'],
  ['settings section has invalid container', 'settings-invalid-container'],
  ['which this version of the SDK does not recognize', 'setting-value-not-recognized'],
  ['has invalid value', 'setting-value-invalid'],
  ['tool definitions section has invalid container', 'tool-definitions-invalid-container'],
  ['tool definition override', 'tool-definition-invalid'],
  ['The agent runs with a request timeout', 'baseline-timeout-not-representable'],
  ['The agent runs with', 'baseline-value-not-describable'],
  ['prefix is added automatically', 'prefix-added-automatically'],
]

function codeOf(message: string): string {
  const found = CODES.find(([fragment]) => message.includes(fragment))
  if (found === undefined) {
    throw new Error(`no spec warning code covers ${JSON.stringify(message)}`)
  }
  return found[1]
}

/** Start each vector from a process that has not warned yet, and hand back what it warns. */
function warnedBy(run: () => void): string[] {
  resetWarnings()
  warnings.messages.length = 0
  run()
  return warnings.messages.map(codeOf)
}

/**
 * The SHA-256 of every vendored file, as it stands in the canonical copy.
 *
 * `spec/` is owned by the Python repository (`pydantic/logfire`), which is where a rule is changed
 * first; the copy in this package is a vendored mirror so the vectors run offline here. A mirror
 * with nothing pinning it is a mirror that drifts, and a drifted vector file is the one artifact
 * that would let the two cores disagree while both of their suites stay green -- so re-vendoring is
 * deliberately a two-line diff: copy the files across, then update these digests to the ones the
 * failure prints.
 */
const SPEC_SHA256: Record<string, string> = {
  'README.md': 'e98e744cf2e55fde90a2882371288cec9daa584b268f36ec94e0147d8c295e58',
  'agent-name.json': '431a25d2745cc211d6489bb9d7ca1e2c47a6e3bbd8436125cf7e123c23c453df',
  'baseline.json': '589fb0f3ef6a3fd0a8d24fe91a105cb5feb3c5a33bbf23b180fc827d19dfab94',
  'config-parsing.json': '6e48cbef934dcc9950e3c33c2db7c83ff80df28171bdffb5c576d5fa36e41515',
  'instructions-apply.json': '053111c38a39c1b807673df103919ff10627072c8c6a9b7bc6acaca552babcef',
  'merge.json': 'f933baa835bf0f8f25635fe917ec5b44b60499b58c5a65830f0b910a6854e2eb',
  'settings-apply.json': '65ff72964b022b895e5cf6749787bf29df68aeeeba04084dc082588e8dfdc836',
  'tools-apply.json': '64e27b93c29e66f7f6d387fe68a39483a535dbcd2145453c4c12c750ea5fa2ef',
}

/**
 * Every issue as the fields it actually set, which is what the vectors compare.
 *
 * The message is left out on purpose: each core words it for its own users, and what has to match
 * across the two is the decision and the path to what it was about.
 */
function issuesAsPaths(issues: readonly ApplyIssue[]): Record<string, unknown>[] {
  // The vectors are the wire form, so the one camel-cased field is written back the way they write
  // it. Every other field's name is already the same in both cores.
  const names: Record<string, string> = { instructionId: 'instruction_id' }
  return issues.map((issue) =>
    Object.fromEntries(
      Object.entries(issue)
        .filter(([name, value]) => name !== 'message' && value !== undefined && value !== null)
        .map(([name, value]) => [names[name] ?? name, value])
    )
  )
}

/**
 * The `support` an apply vector declares, or `undefined` for an adapter that declares nothing.
 *
 * The vector's JSON is the wire form -- arrays, `accepts_additions` -- and this core's own is
 * camel-cased, so the mapping belongs here rather than in each file's assertions.
 */
function supportOf(data: unknown): AgentSupport | undefined {
  if (data === null || data === undefined) {
    return undefined
  }
  const support = data as {
    sections: AgentSupport['sections']
    settings?: string[]
    destinations?: { id: string; default?: boolean; accepts_additions?: boolean }[]
  }
  return {
    sections: support.sections,
    settings: support.settings ?? [],
    destinations: (support.destinations ?? []).map((destination) => ({
      id: destination.id,
      default: destination.default ?? false,
      acceptsAdditions: destination.accepts_additions ?? true,
    })),
  }
}

/** Each part as the vectors write one: `id` even when absent, `dynamic` only when it is set. */
function partsAsJson(blocks: readonly InstructionBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => ({ id: block.id, text: block.text, ...(block.dynamic ? { dynamic: true } : {}) }))
}

/** Each tool as the vectors write one, leaving out what it does not carry. */
function toolsAsJson(tools: readonly ToolDef[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(Object.keys(tool.parametersJsonSchema).length === 0 ? {} : { parameters_json_schema: tool.parametersJsonSchema }),
    ...(tool.toolset === undefined ? {} : { toolset: tool.toolset }),
  }))
}

describe('spec/instructions-apply.json', () => {
  it('applies every published instructions section the way both cores apply it', () => {
    const all = vectors('instructions-apply.json')
    expect(all).toHaveLength(1)
    for (const vector of all) {
      const input = expandRepeats(vector.input) as {
        parts?: { id?: string | null; text: string; dynamic?: boolean }[]
        config: unknown
      }
      const expected = expandRepeats(vector.expected) as { parts?: unknown[]; issues: unknown[] }
      const parts: InstructionBlock[] = (input.parts ?? []).map((part) => ({
        id: part.id ?? null,
        text: part.text,
        dynamic: part.dynamic ?? false,
      }))
      const applied = applyInstructions(parts, parseAgentConfig(input.config))
      expect(partsAsJson(applied.blocks), vector.name).toEqual(expected.parts ?? [])
      expect(issuesAsPaths(applied.issues), vector.name).toEqual(expected.issues)
    }
  })
})

describe('spec/tools-apply.json', () => {
  it('applies every published tool_definitions section the way both cores apply it', () => {
    const all = vectors('tools-apply.json')
    expect(all).toHaveLength(2)
    for (const vector of all) {
      const input = expandRepeats(vector.input) as {
        tools?: { name: string; description?: string; parameters_json_schema?: Record<string, unknown>; toolset?: string }[]
        config: unknown
        reserved?: string[]
        collision_scope?: CollisionScope
      }
      const expected = expandRepeats(vector.expected) as {
        tools?: unknown[]
        routes?: Record<string, string>
        issues: unknown[]
      }
      const tools: ToolDef[] = (input.tools ?? []).map((tool) => ({
        name: tool.name,
        parametersJsonSchema: tool.parameters_json_schema ?? {},
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.toolset === undefined ? {} : { toolset: tool.toolset }),
      }))
      const applied = applyToolDefinitions(tools, parseAgentConfig(input.config), {
        reserved: input.reserved ?? [],
        collisionScope: input.collision_scope ?? 'global',
      })
      expect(toolsAsJson(applied.tools), vector.name).toEqual(expected.tools ?? [])
      if (expected.routes !== undefined) {
        expect({ ...applied.routes }, vector.name).toEqual(expected.routes)
      }
      expect(issuesAsPaths(applied.issues), vector.name).toEqual(expected.issues)
    }
  })
})

describe('spec/settings-apply.json', () => {
  it('applies every published settings section the way both cores apply it', () => {
    const all = vectors('settings-apply.json')
    expect(all).toHaveLength(9)
    for (const vector of all) {
      const input = expandRepeats(vector.input) as { config: unknown; support?: unknown }
      const expected = expandRepeats(vector.expected) as { settings?: unknown; issues: unknown[] }
      const applied = applySettings(parseAgentConfig(input.config), { support: supportOf(input.support) })
      expect(applied.settings, vector.name).toEqual(expected.settings ?? {})
      expect(issuesAsPaths(applied.issues), vector.name).toEqual(expected.issues)
    }
  })
})

describe('spec/merge.json', () => {
  it('merges every set of layers the way both cores merge them', () => {
    const all = vectors('merge.json')
    expect(all).toHaveLength(6)
    for (const vector of all) {
      const input = vector.input as {
        code?: Record<string, unknown>
        published?: Record<string, unknown>
        run_explicit?: Record<string, unknown>
      }
      const expected = vector.expected as { settings: Record<string, unknown>; sources: Record<string, string> }
      const merged = mergeSettings(input.code, input.published, input.run_explicit)
      expect({ ...merged.settings }, vector.name).toEqual(expected.settings)
      expect(Object.fromEntries(merged.sources), vector.name).toEqual(expected.sources)
    }
  })
})

describe('the vendored spec/', () => {
  it('is byte-for-byte the canonical copy', () => {
    for (const [file, digest] of Object.entries(SPEC_SHA256)) {
      const actual = createHash('sha256')
        .update(readFileSync(path.join(SPEC, file)))
        .digest('hex')
      expect(actual, `${file} differs from the canonical spec/ in the Python repository`).toBe(digest)
    }
  })

  it('pins every file in the directory, so a new vector file cannot arrive unpinned', () => {
    expect(readdirSync(SPEC).sort()).toEqual(Object.keys(SPEC_SHA256).sort())
  })
})

describe('spec/agent-name.json', () => {
  it('resolves every name to the variable both cores agree on', () => {
    const all = vectors('agent-name.json')
    expect(all).toHaveLength(19)
    for (const vector of all) {
      const input = vector.input as string
      let variableName: string | undefined
      const codes = warnedBy(() => {
        try {
          variableName = agentVariableName(input)
        } catch {
          variableName = undefined
        }
      })
      if (vector['error'] === 'empty') {
        expect(variableName, vector.name).toBeUndefined()
      } else {
        expect(variableName, vector.name).toBe(vector['variable_name'])
        expect(input.trim(), vector.name).toBe(vector['display_name'])
      }
      expect(codes, vector.name).toEqual(vector['warning'] === undefined ? [] : [vector['warning']])
    }
  })
})

describe('spec/baseline.json', () => {
  it('describes every agent the way both cores describe it', () => {
    const all = vectors('baseline.json')
    expect(all).toHaveLength(15)
    for (const vector of all) {
      const input = vector.input as {
        blocks?: { text: string; id?: string; dynamic?: boolean }[]
        model?: string
        settings?: Record<string, unknown>
        tools?: {
          name: string
          description?: string
          parameters_json_schema?: Record<string, unknown>
          toolset?: string
        }[]
      }
      const instructions: InstructionBlock[] = (input.blocks ?? []).map((block) => ({
        text: block.text,
        id: block.id ?? null,
        dynamic: block.dynamic ?? false,
      }))
      const tools: ToolDef[] = (input.tools ?? []).map((tool) => {
        const def: ToolDef = { name: tool.name, parametersJsonSchema: tool.parameters_json_schema ?? {} }
        if (tool.description !== undefined) {
          def.description = tool.description
        }
        if (tool.toolset !== undefined) {
          def.toolset = tool.toolset
        }
        return def
      })
      let baseline: unknown
      const codes = warnedBy(() => {
        baseline = buildBaseline({
          instructions,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          tools,
        })
      })
      expect(JSON.parse(JSON.stringify(baseline)), vector.name).toEqual(vector.expected)
      expect(codes, vector.name).toEqual(vector.warnings ?? [])
    }
  })
})

describe('spec/config-parsing.json', () => {
  it('parses every published value the way both cores parse it', () => {
    const all = vectors('config-parsing.json')
    expect(all).toHaveLength(30)
    for (const vector of all) {
      let config: ReturnType<typeof parseAgentConfig> | undefined
      const codes = warnedBy(() => {
        config = parseAgentConfig(expandRepeats(vector.input))
      })
      expect(JSON.parse(JSON.stringify(config)), vector.name).toEqual(expandRepeats(vector.expected))
      expect(codes, vector.name).toEqual(vector.warnings)
      if ('unrecognized_settings' in vector) {
        expect(config?.settings?.[UNRECOGNIZED_SETTINGS], vector.name).toEqual(vector['unrecognized_settings'])
      }
    }
  })
})
