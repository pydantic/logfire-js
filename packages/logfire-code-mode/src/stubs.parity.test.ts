import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'

import type { PythonFunction, PythonStubs } from './stubs'

import { pythonFunctions, renderPythonStubs } from './stubs'
import { zodToolSets } from './zodToolSets.fixture'

// `UPDATE_FIXTURES=1 vp test` rewrites the parts of the fixtures that this package produces: the normalized zod
// schemas and the corrected text of each parity exception. `scripts/render-fixtures.py` then renders the
// expected text with pydantic-ai and checks that every stub is valid Python.
const UPDATE = process.env['UPDATE_FIXTURES'] === '1'

const fixtures = new URL('../fixtures/signatures/', import.meta.url)

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'))
}

function writeFixture(name: string, value: unknown): void {
  writeFileSync(new URL(name, fixtures), `${JSON.stringify(value, null, 2)}\n`)
}

interface Expected {
  pydanticAiCommit: string
  cases: Record<string, PythonStubs>
}

interface ParityException {
  reason: string
  expected?: PythonStubs
}

describe('zod tool sets', () => {
  test('normalize to the schemas recorded in zod-cases.json', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const live = Object.fromEntries(Object.entries(zodToolSets).map(([name, tools]) => [name, pythonFunctions(tools).functions]))
    if (UPDATE) {
      writeFixture('zod-cases.json', live)
    }
    expect(JSON.parse(JSON.stringify(live))).toEqual(readFixture('zod-cases.json'))
  })
})

describe('parity with pydantic-ai', () => {
  const cases = {
    ...(readFixture('cases.json') as Record<string, PythonFunction[]>),
    ...(readFixture('zod-cases.json') as Record<string, PythonFunction[]>),
  }
  const expected = readFixture('expected.json') as Expected
  const exceptions = readFixture('parity-exceptions.json') as Record<string, ParityException>

  test('every case was rendered by pydantic-ai', () => {
    expect(Object.keys(expected.cases).sort()).toEqual(Object.keys(cases).sort())
  })

  const matching = Object.entries(cases).filter(([name]) => !Object.hasOwn(exceptions, name))
  const excepted = Object.entries(exceptions).map(([name, exception]) => [name, cases[name] ?? [], exception] as const)

  test.each(matching)('%s matches pydantic-ai', (name, functions) => {
    expect(renderPythonStubs(functions)).toEqual(expected.cases[name])
  })

  test.each(excepted)('%s matches its parity exception', (name, functions, exception) => {
    const actual = renderPythonStubs(functions)
    if (UPDATE) {
      exception.expected = actual
      writeFixture('parity-exceptions.json', exceptions)
    }
    expect(actual).toEqual(exception.expected)
    // An exception that pydantic-ai no longer needs should be removed rather than kept.
    expect(expected.cases[name]).not.toEqual(exception.expected)
  })
})
