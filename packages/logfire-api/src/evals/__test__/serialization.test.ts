/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from 'vitest'

import {
  Case,
  Contains,
  Dataset,
  decodeSpec,
  encodeEvaluatorSpec,
  Equals,
  EqualsExpected,
  IsInstance,
  MaxDuration,
  parseYaml,
  stringifyYaml,
} from '../../evals'

describe('EvaluatorSpec encoding', () => {
  it('null toJSON → bare string', () => {
    expect(encodeEvaluatorSpec(new EqualsExpected())).toBe('EqualsExpected')
  })

  it('single non-dict positional → short form', () => {
    expect(encodeEvaluatorSpec(new Equals({ value: 1 }))).toEqual({ Equals: 1 })
  })

  it('single dict-valued positional uses long form to preserve round-trip', () => {
    // value is an object — short form { Equals: { foo: 1 } } would be ambiguous with kwargs
    expect(encodeEvaluatorSpec(new Equals({ value: { foo: 1 } }))).toEqual({ Equals: { value: { foo: 1 } } })
  })

  it('multi-key kwargs → long form', () => {
    expect(encodeEvaluatorSpec(new Contains({ asStrings: true, value: 'foo' }))).toEqual({
      Contains: { as_strings: true, value: 'foo' },
    })
  })

  it('decodeSpec parses bare string', () => {
    expect(decodeSpec('EqualsExpected')).toEqual({ arguments: null, name: 'EqualsExpected' })
  })

  it('decodeSpec parses single-positional short form into argument array', () => {
    expect(decodeSpec({ Equals: 1 })).toEqual({ arguments: [1], name: 'Equals' })
  })

  it('decodeSpec parses kwargs long form', () => {
    expect(decodeSpec({ Contains: { value: 'foo' } })).toEqual({ arguments: { value: 'foo' }, name: 'Contains' })
  })
})

describe('Dataset YAML round-trip', () => {
  it('serializes a small dataset to YAML in pydantic-evals shape', () => {
    const dataset = new Dataset<{ text: string }, string>({
      cases: [
        new Case<{ text: string }, string>({ expectedOutput: 'POSITIVE', inputs: { text: 'hello' }, name: 'a' }),
        new Case<{ text: string }, string>({
          evaluators: [new Contains({ value: 'POSITIVE' })],
          expectedOutput: 'POSITIVE',
          inputs: { text: 'world' },
          name: 'b',
        }),
      ],
      evaluators: [new EqualsExpected(), new MaxDuration({ seconds: 5 })],
      name: 'sentiment',
    })

    const yaml = dataset.toText('yaml')
    const parsed = parseYaml(yaml) as Record<string, unknown>
    expect(parsed.name).toBe('sentiment')
    expect((parsed.evaluators as unknown[])[0]).toBe('EqualsExpected')
    expect((parsed.evaluators as unknown[])[1]).toEqual({ MaxDuration: 5 })
    const cases = parsed.cases as Record<string, unknown>[]
    expect(cases[0]?.name).toBe('a')
    expect(cases[0]?.expected_output).toBe('POSITIVE')
    expect(cases[1]?.evaluators).toEqual([{ Contains: 'POSITIVE' }])
  })

  it('round-trips dataset → YAML → dataset preserving evaluators', () => {
    const original = new Dataset({
      cases: [
        new Case({
          evaluators: [new Equals({ value: 42 }), new IsInstance({ typeName: 'string' })],
          inputs: 'foo',
          name: 'a',
        }),
      ],
      evaluators: [new EqualsExpected(), new MaxDuration({ seconds: 10 })],
      name: 'roundtrip',
    })
    const yaml = original.toText('yaml')
    const restored = Dataset.fromText(yaml, { format: 'yaml' })

    expect(restored.name).toBe('roundtrip')
    expect(restored.evaluators).toHaveLength(2)
    expect(restored.evaluators[0]).toBeInstanceOf(EqualsExpected)
    expect(restored.evaluators[1]).toBeInstanceOf(MaxDuration)
    expect((restored.evaluators[1] as MaxDuration).seconds).toBe(10)

    expect(restored.cases).toHaveLength(1)
    const caseEvals = restored.cases[0]!.evaluators
    expect(caseEvals).toHaveLength(2)
    expect(caseEvals[0]).toBeInstanceOf(Equals)
    expect((caseEvals[0] as Equals).value).toBe(42)
    expect(caseEvals[1]).toBeInstanceOf(IsInstance)
    expect((caseEvals[1] as IsInstance).typeName).toBe('string')
  })

  it('round-trips dataset → JSON → dataset', () => {
    const original = new Dataset({
      cases: [new Case({ expectedOutput: 1, inputs: { x: 1 }, name: 'a' })],
      evaluators: [new EqualsExpected()],
      name: 'json-test',
    })
    const json = original.toText('json')
    const restored = Dataset.fromText(json, { format: 'json' })
    expect(restored.name).toBe('json-test')
    expect(restored.cases[0]?.expectedOutput).toBe(1)
  })

  it('Dataset.jsonSchema() includes registered built-in evaluators', () => {
    const schema = new Dataset({ cases: [], name: 'x' }).jsonSchema()
    const text = JSON.stringify(schema)
    expect(text).toContain('Equals')
    expect(text).toContain('EqualsExpected')
    expect(text).toContain('Contains')
    expect(text).toContain('IsInstance')
    expect(text).toContain('LLMJudge')
    expect(schema.title).toBe('PydanticEvalsDataset')
  })

  it('toFile + fromFile work on Node and round-trip via the filesystem', async () => {
    const ds = new Dataset({
      cases: [new Case({ inputs: { v: 1 }, name: 'tmp' })],
      evaluators: [new EqualsExpected()],
      name: 'file-test',
    })
    const fs: typeof import('node:fs/promises') = await import('node:fs/promises')
    const os: typeof import('node:os') = await import('node:os')
    const path: typeof import('node:path') = await import('node:path')
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'logfire-evals-'))
    const filePath = path.join(tmpdir, 'dataset.yaml')
    try {
      await ds.toFile(filePath)
      const restored = await Dataset.fromFile(filePath)
      expect(restored.name).toBe('file-test')
      expect(restored.cases[0]?.inputs).toEqual({ v: 1 })
    } finally {
      await fs.rm(tmpdir, { force: true, recursive: true })
    }
  })

  it('toFile writes schema sidecar idempotently when schemaPath is provided', async () => {
    const ds = new Dataset({
      cases: [new Case({ inputs: { v: 1 }, name: 'tmp' })],
      evaluators: [new EqualsExpected()],
      name: 'file-test',
    })
    const fs: typeof import('node:fs/promises') = await import('node:fs/promises')
    const os: typeof import('node:os') = await import('node:os')
    const path: typeof import('node:path') = await import('node:path')
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'logfire-evals-schema-'))
    const filePath = path.join(tmpdir, 'dataset.yaml')
    const schemaPath = path.join(tmpdir, 'dataset.schema.json')
    try {
      await ds.toFile(filePath, { schemaPath: 'dataset.schema.json' })
      expect(await fs.readFile(filePath, 'utf8')).toContain('# yaml-language-server: $schema=dataset.schema.json')
      const firstSchema = await fs.readFile(schemaPath, 'utf8')
      const parsedSchema = JSON.parse(firstSchema) as { title?: unknown }
      expect(parsedSchema.title).toBe('PydanticEvalsDataset')
      const firstMtime = (await fs.stat(schemaPath)).mtimeMs

      await new Promise((resolve) => setTimeout(resolve, 20))
      await ds.toFile(filePath, { schemaPath: 'dataset.schema.json' })

      expect(await fs.readFile(schemaPath, 'utf8')).toBe(firstSchema)
      expect((await fs.stat(schemaPath)).mtimeMs).toBe(firstMtime)
    } finally {
      await fs.rm(tmpdir, { force: true, recursive: true })
    }
  })

  it('rejects malformed dataset objects with a helpful zod error', () => {
    expect(() => Dataset.fromObject({ cases: 'not-an-array', name: 'x' })).toThrow()
  })
})

describe('YAML helpers', () => {
  it('parseYaml reads a Python-style dataset', () => {
    const yaml = `
name: example
cases:
  - name: c1
    inputs: { text: hello }
    expected_output: GOOD
    evaluators:
      - Contains: GOOD
evaluators:
  - EqualsExpected
`
    const parsed = parseYaml(yaml) as Record<string, unknown>
    expect(parsed.name).toBe('example')
    const cases = parsed.cases as Record<string, unknown>[]
    expect(cases[0]?.evaluators).toEqual([{ Contains: 'GOOD' }])
    expect(parsed.evaluators).toEqual(['EqualsExpected'])
  })

  it('stringifyYaml emits round-trippable text', () => {
    const obj = { evaluators: ['EqualsExpected', { Contains: 'foo' }], name: 'x' }
    const text = stringifyYaml(obj)
    expect(parseYaml(text)).toEqual(obj)
  })
})
