import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { Case, ConfusionMatrixEvaluator, Contains, Dataset, EqualsExpected, Evaluator, MaxDuration, ReportEvaluator } from './evals'
import type { EvaluationDatasetValueContext } from './datasets'
import { DatasetConfigurationError, LogfireAPIClient } from './datasets'

interface CapturedRequest {
  body: unknown
  method: string
  url: string
}

const hostedMetadata = {
  case_count: 2,
  id: 'dataset-123',
  name: 'qa-golden-set',
}

class EmptyObjectEvaluator extends Evaluator {
  static override evaluatorName = 'EmptyObjectEvaluator'

  evaluate(): boolean {
    return true
  }

  override toJSON(): Record<string, unknown> {
    return {}
  }
}

class EmptyArrayEvaluator extends Evaluator {
  static override evaluatorName = 'EmptyArrayEvaluator'

  evaluate(): boolean {
    return true
  }

  override toJSON(): unknown[] {
    return []
  }
}

class MultiArrayEvaluator extends Evaluator {
  static override evaluatorName = 'MultiArrayEvaluator'

  evaluate(): boolean {
    return true
  }

  override toJSON(): unknown[] {
    return ['left', 'right']
  }
}

class ThresholdReportEvaluator extends ReportEvaluator {
  static override evaluatorName = 'ThresholdReportEvaluator'
  readonly minPassRate: number

  constructor(opts: { minPassRate?: number; min_pass_rate?: number } = {}) {
    super()
    this.minPassRate = opts.minPassRate ?? opts.min_pass_rate ?? 0.5
  }

  evaluate() {
    return { title: 'pass rate', type: 'scalar' as const, value: this.minPassRate }
  }

  override toJSON(): Record<string, unknown> {
    return { min_pass_rate: this.minPassRate }
  }
}

describe('hosted evaluation datasets bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushEvaluationDataset creates, imports cases, and returns hosted metadata', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [jsonResponse({ ...hostedMetadata }), jsonResponse([{ id: 'case-1' }]), jsonResponse(hostedMetadata)]),
    })
    const dataset = new Dataset({
      cases: [
        new Case({
          evaluators: [new Contains({ value: '4' })],
          expectedOutput: { answer: '4' },
          inputs: { question: 'What is 2+2?' },
          metadata: { source: 'seed' },
          name: 'arithmetic-1',
        }),
        new Case({
          inputs: { question: 'unnamed case' },
        }),
      ],
      evaluators: [new EqualsExpected(), new EmptyObjectEvaluator()],
      name: 'qa-golden-set',
      reportEvaluators: [new ThresholdReportEvaluator({ minPassRate: 0.8 })],
    })

    const result = await client.pushEvaluationDataset(dataset, {
      description: 'Golden arithmetic cases',
      inputSchema: { type: 'object' },
      metadataSchema: null,
      outputSchema: { type: 'object' },
    })

    expect(result).toEqual(hostedMetadata)
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://example.com/v1/datasets/'],
      ['POST', 'https://example.com/v1/datasets/qa-golden-set/import/?on_conflict=update'],
      ['GET', 'https://example.com/v1/datasets/qa-golden-set/'],
    ])
    expect(calls[0]?.body).toEqual({
      description: 'Golden arithmetic cases',
      evaluators: [
        { arguments: null, name: 'EqualsExpected' },
        { arguments: null, name: 'EmptyObjectEvaluator' },
      ],
      input_schema: { type: 'object' },
      metadata_schema: null,
      name: 'qa-golden-set',
      output_schema: { type: 'object' },
      report_evaluators: [{ arguments: { min_pass_rate: 0.8 }, name: 'ThresholdReportEvaluator' }],
    })
    expect(calls[1]?.body).toEqual({
      cases: [
        {
          evaluators: [{ arguments: { value: '4' }, name: 'Contains' }],
          expected_output: { answer: '4' },
          inputs: { question: 'What is 2+2?' },
          metadata: { source: 'seed' },
          name: 'arithmetic-1',
        },
        {
          evaluators: [],
          inputs: { question: 'unnamed case' },
        },
      ],
    })
  })

  it('pushEvaluationDataset updates on 409 and forwards null and undefined schema semantics', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [
        jsonResponse({ detail: 'already exists' }, 409),
        jsonResponse(hostedMetadata),
        jsonResponse([{ id: 'case-1' }]),
        jsonResponse(hostedMetadata),
      ]),
    })
    const dataset = new Dataset({
      cases: [new Case({ inputs: { question: 'q' }, name: 'case-1' })],
      name: 'local-name',
    })

    await client.pushEvaluationDataset(dataset, {
      description: null,
      metadataSchema: { type: 'object' },
      name: 'remote-name',
      onCaseConflict: 'error',
      outputSchema: null,
    })

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://example.com/v1/datasets/'],
      ['PATCH', 'https://example.com/v1/datasets/remote-name/'],
      ['POST', 'https://example.com/v1/datasets/remote-name/import/?on_conflict=error'],
      ['GET', 'https://example.com/v1/datasets/remote-name/'],
    ])
    expect(calls[0]?.body).toEqual({
      description: null,
      evaluators: [],
      metadata_schema: { type: 'object' },
      name: 'remote-name',
      output_schema: null,
      report_evaluators: [],
    })
    expect(calls[1]?.body).toEqual({
      description: null,
      evaluators: [],
      metadata_schema: { type: 'object' },
      output_schema: null,
      report_evaluators: [],
    })
  })

  it('pushEvaluationDataset trims the resolved hosted dataset name', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [jsonResponse(hostedMetadata), jsonResponse(hostedMetadata)]),
    })

    await client.pushEvaluationDataset(
      new Dataset({
        cases: [],
        name: ' local-name ',
      }),
      { name: ' remote-name ' }
    )

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://example.com/v1/datasets/'],
      ['GET', 'https://example.com/v1/datasets/remote-name/'],
    ])
    expect(calls[0]?.body).toMatchObject({ name: 'remote-name' })
  })

  it('pushEvaluationDataset propagates non-409 API errors', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse({ detail: 'invalid schema' }, 422)]),
    })
    const dataset = new Dataset({ cases: [], name: 'bad-dataset' })

    await expect(client.pushEvaluationDataset(dataset)).rejects.toMatchObject({
      detail: { detail: 'invalid schema' },
      status: 422,
    })
  })

  it('pushEvaluationDataset requires a target name and skips case import for empty datasets', async () => {
    const unnamedClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], []),
    })
    await expect(unnamedClient.pushEvaluationDataset(new Dataset({ cases: [], name: '' }))).rejects.toBeInstanceOf(
      DatasetConfigurationError
    )

    const calls: CapturedRequest[] = []
    const emptyClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [jsonResponse(hostedMetadata), jsonResponse(hostedMetadata)]),
    })
    await emptyClient.pushEvaluationDataset(new Dataset({ cases: [], name: 'empty-dataset' }))

    expect(calls.map((call) => call.url)).toEqual(['https://example.com/v1/datasets/', 'https://example.com/v1/datasets/empty-dataset/'])
  })

  it('pushEvaluationDataset folds empty evaluator arrays and rejects multi-positional evaluator arguments', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [jsonResponse(hostedMetadata), jsonResponse(hostedMetadata)]),
    })

    await client.pushEvaluationDataset(
      new Dataset({
        cases: [],
        evaluators: [new EmptyArrayEvaluator()],
        name: 'empty-array-eval',
      })
    )
    expect(calls[0]?.body).toMatchObject({
      evaluators: [{ arguments: null, name: 'EmptyArrayEvaluator' }],
    })

    const badClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], []),
    })
    await expect(
      badClient.pushEvaluationDataset(
        new Dataset({
          cases: [],
          evaluators: [new MultiArrayEvaluator()],
          name: 'bad-eval',
        })
      )
    ).rejects.toThrow('multi-element positional argument arrays')
  })

  it('normalizes JSON values and supports a constrained serializeValue hook', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [jsonResponse(hostedMetadata), jsonResponse([{ id: 'case-1' }]), jsonResponse(hostedMetadata)]),
    })

    await client.pushEvaluationDataset(
      new Dataset({
        cases: [
          new Case({
            expectedOutput: { seenAt: new Date('2026-06-02T10:00:00.000Z') },
            inputs: { createdAt: new Date('2026-06-02T09:00:00.000Z'), tags: new Set(['a', 'b']) },
            name: 'dates-and-sets',
          }),
        ],
        name: 'json-normalized',
      }),
      {
        serializeValue(value) {
          if (value instanceof Set) {
            return Array.from(value as Set<unknown>)
          }
          return undefined
        },
      }
    )

    expect(calls[1]?.body).toEqual({
      cases: [
        {
          evaluators: [],
          expected_output: { seenAt: '2026-06-02T10:00:00.000Z' },
          inputs: { createdAt: '2026-06-02T09:00:00.000Z', tags: ['a', 'b'] },
          name: 'dates-and-sets',
        },
      ],
    })
  })

  it('serializes shared unsupported values without treating sibling references as cycles', async () => {
    const calls: CapturedRequest[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(calls, [jsonResponse(hostedMetadata), jsonResponse([{ id: 'case-1' }]), jsonResponse(hostedMetadata)]),
    })
    const shared = new Set(['x'])

    await client.pushEvaluationDataset(
      new Dataset({
        cases: [
          new Case({
            inputs: { first: shared, second: shared },
            name: 'shared-set',
          }),
        ],
        name: 'shared-values',
      }),
      {
        serializeValue(value) {
          if (value instanceof Set) {
            return Array.from(value as Set<unknown>)
          }
          return undefined
        },
      }
    )

    expect(calls[1]?.body).toEqual({
      cases: [
        {
          evaluators: [],
          inputs: { first: ['x'], second: ['x'] },
          name: 'shared-set',
        },
      ],
    })
  })

  it('rejects circular pushed values and serialize-induced cycles', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], []),
    })
    const circularArray: unknown[] = []
    circularArray.push(circularArray)
    const circularObject: Record<string, unknown> = {}
    circularObject['self'] = circularObject
    const recursiveSet = new Set(['x'])
    const recursiveBigInt = 1n

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { recursive: circularArray }, name: 'bad-array-cycle' })],
          name: 'bad-json',
        })
      )
    ).rejects.toThrow('contains a circular array')

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { recursive: circularObject }, name: 'bad-object-cycle' })],
          name: 'bad-json',
        })
      )
    ).rejects.toThrow('contains a circular object')

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { value: recursiveSet }, name: 'bad-serialize-cycle' })],
          name: 'bad-json',
        }),
        {
          serializeValue(value) {
            if (value instanceof Set) {
              return { wrap: value }
            }
            return undefined
          },
        }
      )
    ).rejects.toThrow('serializeValue returned the same unsupported Set value')

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { value: recursiveBigInt }, name: 'bad-primitive-serialize-cycle' })],
          name: 'bad-json',
        }),
        {
          serializeValue(value) {
            if (typeof value === 'bigint') {
              return { wrap: value }
            }
            return undefined
          },
        }
      )
    ).rejects.toThrow('serializeValue returned the same unsupported bigint value')
  })

  it('rejects unsupported pushed values with path-aware messages', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], []),
    })

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { tags: new Set(['a']) }, name: 'bad-set' })],
          name: 'bad-json',
        })
      )
    ).rejects.toThrow('$.cases[0].inputs.tags')

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { tags: new Set(['a']) }, name: 'bad-serializer' })],
          name: 'bad-json',
        }),
        {
          serializeValue(value) {
            if (value instanceof Set) {
              return new Map()
            }
            return undefined
          },
        }
      )
    ).rejects.toThrow('serializeValue did not convert')

    await expect(
      client.pushEvaluationDataset(
        new Dataset({
          cases: [new Case({ inputs: { question: 'q' }, metadata: { unsafe: undefined }, name: 'bad-undefined' })],
          name: 'bad-json',
        })
      )
    ).rejects.toThrow('$.cases[0].metadata.unsafe')
  })

  it('getEvaluationDataset converts hosted exports to local executable datasets', async () => {
    const rawExport = {
      cases: [
        {
          created_at: '2026-06-02T00:00:00Z',
          evaluators: [{ arguments: { value: '4' }, name: 'Contains' }],
          expected_output: { answer: '4' },
          id: 'case-1',
          inputs: { question: 'What is 2+2?' },
          metadata: { source: 'seed' },
          name: 'arithmetic-1',
          tags: ['hosted'],
          updated_at: '2026-06-02T01:00:00Z',
        },
      ],
      evaluators: [{ arguments: null, name: 'EqualsExpected' }, { MaxDuration: 5 }],
      name: 'qa-golden-set',
      report_evaluators: [{ arguments: { predicted_from: 'output' }, name: 'ConfusionMatrixEvaluator' }],
    }
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse(rawExport)]),
    })

    const dataset = await client.getEvaluationDataset('qa-golden-set')

    expect(dataset).toBeInstanceOf(Dataset)
    expect(dataset.name).toBe('qa-golden-set')
    expect(dataset.evaluators[0]).toBeInstanceOf(EqualsExpected)
    expect(dataset.evaluators[1]).toBeInstanceOf(MaxDuration)
    expect(dataset.reportEvaluators[0]).toBeInstanceOf(ConfusionMatrixEvaluator)
    const firstCase = dataset.cases[0]
    expect(firstCase?.name).toBe('arithmetic-1')
    expect(firstCase?.inputs).toEqual({ question: 'What is 2+2?' })
    expect(firstCase?.expectedOutput).toEqual({ answer: '4' })
    expect(firstCase?.metadata).toEqual({ source: 'seed' })
    expect(firstCase?.evaluators[0]).toBeInstanceOf(Contains)
    expect(firstCase === undefined ? false : 'id' in firstCase).toBe(false)
    expect(firstCase === undefined ? false : 'tags' in firstCase).toBe(false)
    expect(firstCase === undefined ? false : 'created_at' in firstCase).toBe(false)
  })

  it('getEvaluationDataset supports custom evaluators and parser hooks', async () => {
    class CustomEvaluator extends Evaluator {
      static override evaluatorName = 'CustomEvaluator'
      readonly value: string

      constructor(opts: { value: string }) {
        super()
        this.value = opts.value
      }

      evaluate(): boolean {
        return true
      }
    }

    class CustomReportEvaluator extends ReportEvaluator {
      static override evaluatorName = 'CustomReportEvaluator'
      readonly title: string

      constructor(opts: { title: string }) {
        super()
        this.title = opts.title
      }

      evaluate() {
        return { title: this.title, type: 'scalar' as const, value: 1 }
      }
    }

    const contexts: EvaluationDatasetValueContext[] = []
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(
        [],
        [
          jsonResponse({
            cases: [
              {
                evaluators: [{ arguments: { value: 'case' }, name: 'CustomEvaluator' }],
                expected_output: { answer: '4' },
                inputs: { question: 'q' },
                metadata: { source: 'seed' },
                name: 'case-1',
              },
            ],
            evaluators: [{ arguments: { value: 'dataset' }, name: 'CustomEvaluator' }],
            name: 'custom-dataset',
            report_evaluators: [{ arguments: { title: 'custom report' }, name: 'CustomReportEvaluator' }],
          }),
        ]
      ),
    })

    const dataset = await client.getEvaluationDataset<{ parsedInput: string }, { parsedOutput: string }, { parsedMetadata: string }>(
      'custom-dataset',
      {
        customEvaluators: [CustomEvaluator],
        customReportEvaluators: [CustomReportEvaluator],
        parseExpectedOutput(value, context) {
          contexts.push(context)
          return { parsedOutput: JSON.stringify(value) }
        },
        parseInputs(value, context) {
          contexts.push(context)
          return { parsedInput: JSON.stringify(value) }
        },
        parseMetadata(value, context) {
          contexts.push(context)
          return { parsedMetadata: JSON.stringify(value) }
        },
      }
    )

    expect(dataset.evaluators[0]).toBeInstanceOf(CustomEvaluator)
    expect((dataset.evaluators[0] as CustomEvaluator).value).toBe('dataset')
    expect(dataset.reportEvaluators[0]).toBeInstanceOf(CustomReportEvaluator)
    expect((dataset.reportEvaluators[0] as CustomReportEvaluator).title).toBe('custom report')
    expect(dataset.cases[0]?.evaluators[0]).toBeInstanceOf(CustomEvaluator)
    expect(dataset.cases[0]?.inputs).toEqual({ parsedInput: '{"question":"q"}' })
    expect(dataset.cases[0]?.expectedOutput).toEqual({ parsedOutput: '{"answer":"4"}' })
    expect(dataset.cases[0]?.metadata).toEqual({ parsedMetadata: '{"source":"seed"}' })
    expect(contexts).toEqual([
      { caseIndex: 0, caseName: 'case-1', field: 'inputs', path: '$.cases[0].inputs' },
      { caseIndex: 0, caseName: 'case-1', field: 'expectedOutput', path: '$.cases[0].expected_output' },
      { caseIndex: 0, caseName: 'case-1', field: 'metadata', path: '$.cases[0].metadata' },
    ])
  })

  it('getEvaluationDataset keeps strict decoder failures and duplicate case-name errors', async () => {
    const unknownClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(
        [],
        [jsonResponse({ cases: [{ inputs: 1 }], evaluators: [{ arguments: null, name: 'MissingEvaluator' }], name: 'bad' })]
      ),
    })
    await expect(unknownClient.getEvaluationDataset('bad')).rejects.toThrow('Unknown evaluator name')

    const duplicateClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence(
        [],
        [
          jsonResponse({
            cases: [
              { inputs: 1, name: 'dup' },
              { inputs: 2, name: 'dup' },
            ],
            name: 'bad',
          }),
        ]
      ),
    })
    await expect(duplicateClient.getEvaluationDataset('bad')).rejects.toThrow('Duplicate case name')
  })

  it('getDataset remains raw hosted JSON', async () => {
    const rawExport = {
      cases: [{ id: 'case-1', inputs: { question: 'q' }, tags: ['raw'] }],
      evaluators: [{ arguments: null, name: 'HostedOnlyEvaluator' }],
      name: 'raw-dataset',
    }
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse(rawExport)]),
    })

    await expect(client.getDataset('raw-dataset')).resolves.toEqual(rawExport)
  })
})

function fetchSequence(calls: CapturedRequest[], responses: Response[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    await Promise.resolve()
    const response = responses.shift()
    if (response === undefined) {
      throw new Error(`Unexpected fetch call to ${requestInputToUrl(input)}`)
    }
    calls.push({
      body: parseJsonBody(init?.body),
      method: init?.method ?? 'GET',
      url: requestInputToUrl(input),
    })
    return response
  })
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined
}

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}
