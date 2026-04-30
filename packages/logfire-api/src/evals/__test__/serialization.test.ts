/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from 'vite-plus/test'

import {
  buildDatasetJsonSchema,
  Case,
  ConfusionMatrixEvaluator,
  Contains,
  Dataset,
  decodeEvaluator,
  decodeReportEvaluator,
  decodeSpec,
  encodeEvaluatorSpec,
  Equals,
  EqualsExpected,
  Evaluator,
  IsInstance,
  MaxDuration,
  parseYaml,
  registerEvaluator,
  ReportEvaluator,
  stringifyYaml,
} from '../../evals'

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

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

  it('decodeSpec rejects malformed encodings and preserves explicit null positional values', () => {
    expect(() => decodeSpec(null)).toThrow('Invalid evaluator encoding: null')
    expect(() => decodeSpec(1)).toThrow('Invalid evaluator encoding: 1')
    expect(() => decodeSpec({})).toThrow('Evaluator encoding must be a single-key object (got keys: )')
    expect(() => decodeSpec({ A: 1, B: 2 })).toThrow('Evaluator encoding must be a single-key object (got keys: A, B)')
    expect(decodeSpec({ MaybeNull: null })).toEqual({ arguments: [null], name: 'MaybeNull' })
  })

  it('decodeEvaluator constructs from map/object registries and reports unknown names', () => {
    class PairEvaluator extends Evaluator {
      static evaluatorName = 'PairEvaluator'
      readonly left: string
      readonly right: number

      constructor(left: string, right: number) {
        super()
        this.left = left
        this.right = right
      }
      evaluate(): boolean {
        return this.left === 'x' && this.right === 2
      }
    }

    class ValueEvaluator extends Evaluator {
      static evaluatorName = 'ValueEvaluator'
      readonly value: unknown
      constructor(opts: { value: unknown }) {
        super()
        this.value = opts.value
      }
      evaluate(): boolean {
        return true
      }
    }

    const pair = decodeEvaluator({ PairEvaluator: ['x', 2] }, new Map([['PairEvaluator', PairEvaluator as never]]), new Map())
    expect(pair).toBeInstanceOf(PairEvaluator)
    expect((pair as PairEvaluator).evaluate()).toBe(true)

    const value = decodeEvaluator(
      { ValueEvaluator: 42 },
      { ValueEvaluator: ValueEvaluator as never },
      new Map([['ValueEvaluator', 'value']])
    )
    expect(value).toBeInstanceOf(ValueEvaluator)
    expect((value as ValueEvaluator).value).toBe(42)

    expect(() => decodeEvaluator('Missing', new Map([['ValueEvaluator', ValueEvaluator as never]]), new Map())).toThrow(
      'Unknown evaluator name: "Missing" (registered: ValueEvaluator)'
    )
  })

  it('decodeReportEvaluator constructs report evaluators and reports unknown names', () => {
    class TableReportEvaluator extends ReportEvaluator {
      static evaluatorName = 'TableReportEvaluator'
      readonly title: string
      constructor(opts: { title: string }) {
        super()
        this.title = opts.title
      }
      evaluate() {
        return { columns: ['x'], rows: [[this.title]], title: this.title, type: 'table' as const }
      }
    }

    const decoded = decodeReportEvaluator(
      { TableReportEvaluator: { title: 'custom' } },
      { TableReportEvaluator: TableReportEvaluator as never },
      new Map()
    )
    expect(decoded).toBeInstanceOf(TableReportEvaluator)
    expect((decoded as TableReportEvaluator).title).toBe('custom')
    expect(() => decodeReportEvaluator('MissingReport', {}, new Map())).toThrow('Unknown report evaluator name: "MissingReport"')
  })

  it('custom json schema providers narrow evaluator argument schemas', () => {
    class SchemaEvaluator extends Evaluator {
      static evaluatorName = 'SchemaEvaluator'
      static jsonSchema() {
        return { additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'], type: 'object' }
      }
      evaluate(): boolean {
        return true
      }
    }

    class NullSchemaEvaluator extends Evaluator {
      static evaluatorName = 'NullSchemaEvaluator'
      static jsonSchema() {
        return null
      }
      evaluate(): boolean {
        return true
      }
    }

    const schema = buildDatasetJsonSchema({
      customEvaluators: [SchemaEvaluator as never, NullSchemaEvaluator as never],
    })
    const text = JSON.stringify(schema)
    expect(text).toContain('"SchemaEvaluator"')
    expect(text).toContain('"value":{"type":"string"}')
    expect(text).toContain('"NullSchemaEvaluator"')
    expect(text).toContain('"properties":{"NullSchemaEvaluator":{}}')
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

  it('toObject includes schema, report evaluators, case metadata and per-case evaluators', () => {
    const dataset = new Dataset({
      cases: [
        new Case({
          evaluators: [new Contains({ value: 'ok' })],
          expectedOutput: 'ok',
          inputs: 'input',
          metadata: { split: 'test' },
          name: 'case-a',
        }),
      ],
      evaluators: [new EqualsExpected()],
      name: 'object-test',
      reportEvaluators: [new ConfusionMatrixEvaluator({ expected: { from: 'expected_output' }, predicted: { from: 'output' } })],
    })

    expect(dataset.toObject({ schemaPath: './schema.json' })).toEqual({
      $schema: './schema.json',
      cases: [
        {
          evaluators: [{ Contains: 'ok' }],
          expected_output: 'ok',
          inputs: 'input',
          metadata: { split: 'test' },
          name: 'case-a',
        },
      ],
      evaluators: ['EqualsExpected'],
      name: 'object-test',
      report_evaluators: ['ConfusionMatrixEvaluator'],
    })
  })

  it('uses defaultName and custom evaluator registries when restoring objects', () => {
    class CustomEvaluator extends Evaluator {
      static evaluatorName = 'CustomEvaluator'
      readonly value: string
      constructor(opts: { value: string }) {
        super()
        this.value = opts.value
      }
      evaluate(): boolean {
        return true
      }
    }

    const restored = Dataset.fromObject(
      {
        cases: [{ evaluators: [{ CustomEvaluator: 'case' }], inputs: 1 }],
        evaluators: [{ CustomEvaluator: 'dataset' }],
      },
      {
        customEvaluators: [CustomEvaluator as never],
        defaultName: 'default-name',
        primaryArgKeys: { CustomEvaluator: 'value' },
      }
    )

    expect(restored.name).toBe('default-name')
    expect(restored.evaluators[0]).toBeInstanceOf(CustomEvaluator)
    expect((restored.evaluators[0] as CustomEvaluator).value).toBe('dataset')
    expect(restored.cases[0]?.evaluators[0]).toBeInstanceOf(CustomEvaluator)
    expect((restored.cases[0]?.evaluators[0] as CustomEvaluator).value).toBe('case')
  })

  it('falls back to globally registered custom evaluators when no custom registry is provided', () => {
    class GloballyRegisteredEvaluator extends Evaluator {
      static evaluatorName = 'GloballyRegisteredEvaluator'
      readonly value: string
      constructor(opts: { value: string }) {
        super()
        this.value = opts.value
      }
      evaluate(): boolean {
        return true
      }
    }

    registerEvaluator(GloballyRegisteredEvaluator as never)
    const restored = Dataset.fromObject(
      {
        cases: [{ inputs: 1 }],
        evaluators: [{ GloballyRegisteredEvaluator: 'global' }],
        name: 'global-registry',
      },
      { primaryArgKeys: { GloballyRegisteredEvaluator: 'value' } }
    )

    expect(restored.evaluators[0]).toBeInstanceOf(GloballyRegisteredEvaluator)
    expect((restored.evaluators[0] as GloballyRegisteredEvaluator).value).toBe('global')
  })

  it('Dataset.jsonSchema() includes registered built-in evaluators', () => {
    const schema = new Dataset({ cases: [], name: 'x' }).jsonSchema()
    const text = JSON.stringify(schema)
    expect(text).toContain('Equals')
    expect(text).toContain('EqualsExpected')
    expect(text).toContain('Contains')
    expect(text).toContain('IsInstance')
    expect(text).toContain('LLMJudge')
    expect(text).toContain('case_sensitive')
    expect(text).toContain('predicted_from')
    expect(text).toContain('score_key')
    expect(schema.title).toBe('PydanticEvalsDataset')
  })

  it('reads and writes Python-compatible flat ConfusionMatrixEvaluator options', () => {
    const restored = Dataset.fromObject({
      cases: [{ inputs: 'x' }],
      name: 'flat-report-evaluator',
      report_evaluators: [
        {
          ConfusionMatrixEvaluator: {
            expected_from: 'metadata',
            predicted_from: 'labels',
            predicted_key: 'predicted',
          },
        },
      ],
    })

    expect(restored.reportEvaluators[0]).toBeInstanceOf(ConfusionMatrixEvaluator)
    expect(restored.reportEvaluators[0]?.toJSON()).toEqual({
      expected_from: 'metadata',
      predicted_from: 'labels',
      predicted_key: 'predicted',
    })
  })

  it('toFile + fromFile work on Node and round-trip via the filesystem', async () => {
    const ds = new Dataset({
      cases: [new Case({ inputs: { v: 1 }, name: 'tmp' })],
      evaluators: [new EqualsExpected()],
      name: 'file-test',
    })
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
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
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
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

      await sleep(20)
      await ds.toFile(filePath, { schemaPath: 'dataset.schema.json' })

      expect(await fs.readFile(schemaPath, 'utf8')).toBe(firstSchema)
      expect((await fs.stat(schemaPath)).mtimeMs).toBe(firstMtime)
    } finally {
      await fs.rm(tmpdir, { force: true, recursive: true })
    }
  })

  it('prefers Deno readTextFile/writeTextFile helpers when present', async () => {
    const originalDeno = (globalThis as { Deno?: unknown }).Deno
    const files = new Map<string, string>()
    const calls: string[] = []
    ;(globalThis as { Deno?: unknown }).Deno = {
      readTextFile: async (path: string) => {
        calls.push(`read:${path}`)
        const text = files.get(path)
        return text === undefined ? Promise.reject(new Error(`missing ${path}`)) : Promise.resolve(text)
      },
      writeTextFile: async (path: string, text: string) => {
        calls.push(`write:${path}`)
        files.set(path, text)
        return Promise.resolve()
      },
    }

    try {
      const ds = new Dataset({
        cases: [new Case({ inputs: { v: 1 }, name: 'tmp' })],
        name: 'deno-file-test',
      })
      await ds.toFile('/tmp/deno-dataset.yaml', { schemaPath: 'deno.schema.json' })
      expect(calls).toEqual(['write:/tmp/deno-dataset.yaml', 'read:/tmp/deno.schema.json', 'write:/tmp/deno.schema.json'])
      expect(files.get('/tmp/deno-dataset.yaml')).toContain('# yaml-language-server: $schema=deno.schema.json')
      const restored = await Dataset.fromFile('/tmp/deno-dataset.yaml')
      expect(restored.name).toBe('deno-file-test')
      expect(restored.cases[0]?.inputs).toEqual({ v: 1 })
    } finally {
      ;(globalThis as { Deno?: unknown }).Deno = originalDeno
    }
  })

  it('rejects malformed dataset objects with a helpful zod error', () => {
    expect(() => Dataset.fromObject({ cases: 'not-an-array', name: 'x' })).toThrow(/expected array/i)
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
