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
 * Three things have to give the same answer in Python and TypeScript, because a Logfire project is
 * shared and the SDKs are not: which variable an agent's config lives in, what a code baseline says,
 * and what a published value parses to. `spec/` is where those answers live, and this is the half of
 * the agreement this package keeps. A change to a rule changes the file first, and both cores after.
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
import { agentVariableName, buildBaseline, parseAgentConfig } from '../index'
import type { InstructionBlock, ToolDef } from '../index'
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
  'README.md': '22f5a2680e26decc6caa43c55538a789ea5e455af188db3dbff4b682800a833c',
  'agent-name.json': '431a25d2745cc211d6489bb9d7ca1e2c47a6e3bbd8436125cf7e123c23c453df',
  'baseline.json': '589fb0f3ef6a3fd0a8d24fe91a105cb5feb3c5a33bbf23b180fc827d19dfab94',
  'config-parsing.json': '6e48cbef934dcc9950e3c33c2db7c83ff80df28171bdffb5c576d5fa36e41515',
}

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
