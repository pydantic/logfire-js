import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { DatasetApiError } from './datasets'
import {
  CaseNotFoundError,
  DatasetConfigurationError,
  DatasetNotFoundError,
  DatasetTimeoutError,
  DatasetTransportError,
  LogfireAPIClient,
} from './datasets'

interface CapturedRequest {
  body: unknown
  headers: Headers
  method: string
  url: string
}

const hostedDataset = {
  case_count: 1,
  created_at: '2026-06-02T00:00:00Z',
  description: 'Test dataset',
  id: 'dataset-123',
  input_schema: { type: 'object' },
  name: 'test-dataset',
  report_evaluators: [{ arguments: { min_pass_rate: 0.9 }, name: 'PassRate' }],
}

const hostedCase = {
  expected_output: { answer: '4' },
  id: 'case-456',
  inputs: { question: 'What is 2+2?' },
  metadata: { source: 'seed' },
  name: 'arithmetic-1',
}

describe('hosted datasets API client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses API key auth, trims base URLs, and returns raw response fields', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [jsonResponse([hostedDataset])])
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com/',
      fetch: fetchImpl,
    })

    const result = await client.listDatasets()

    expect(result).toEqual([hostedDataset])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://example.com/v1/datasets/')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers.get('Authorization')).toBe('bearer lf-api-key')
    expect(calls[0]?.headers.get('Accept')).toBe('application/json')
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json')
    expect(result[0]?.input_schema).toEqual({ type: 'object' })
  })

  it('preserves path prefixes in custom base URLs', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [jsonResponse([hostedDataset])])
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com/platform/',
      fetch: fetchImpl,
    })

    await client.listDatasets()

    expect(calls[0]?.url).toBe('https://example.com/platform/v1/datasets/')
  })

  it('infers the client base URL from the API key region', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [jsonResponse([hostedDataset])])
    const client = new LogfireAPIClient({
      apiKey: 'pylf_v1_eu_mFMvBQ7BWLPJ0fHYBGLVBmJ70TpkhlskgRLng0jFsb3n',
      fetch: fetchImpl,
    })

    await client.listDatasets()

    expect(calls[0]?.url).toBe('https://logfire-eu.pydantic.dev/v1/datasets/')
  })

  it('maps camelCase dataset write options to snake_case request bodies', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [jsonResponse(hostedDataset), jsonResponse({ ...hostedDataset, description: null })])
    const client = new LogfireAPIClient({ apiKey: 'lf-api-key', baseUrl: 'https://example.com', fetch: fetchImpl })

    await client.createDataset({
      description: 'Test dataset',
      evaluators: [{ arguments: null, name: 'DatasetEval' }],
      inputSchema: { type: 'object' },
      metadataSchema: { type: 'object' },
      name: 'test-dataset',
      outputSchema: { type: 'object' },
      reportEvaluators: [{ arguments: { min_pass_rate: 0.9 }, name: 'PassRate' }],
    })
    await client.updateDataset('test-dataset', {
      description: null,
      inputSchema: null,
      reportEvaluators: null,
    })

    expect(calls[0]?.url).toBe('https://example.com/v1/datasets/')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({
      description: 'Test dataset',
      evaluators: [{ arguments: null, name: 'DatasetEval' }],
      input_schema: { type: 'object' },
      metadata_schema: { type: 'object' },
      name: 'test-dataset',
      output_schema: { type: 'object' },
      report_evaluators: [{ arguments: { min_pass_rate: 0.9 }, name: 'PassRate' }],
    })
    expect(calls[1]?.url).toBe('https://example.com/v1/datasets/test-dataset/')
    expect(calls[1]?.method).toBe('PATCH')
    expect(calls[1]?.body).toEqual({
      description: null,
      input_schema: null,
      report_evaluators: null,
    })
  })

  it('uses metadata and export endpoints for getDataset includeCases behavior', async () => {
    const calls: CapturedRequest[] = []
    const exportPayload = {
      cases: [hostedCase],
      evaluators: [{ arguments: null, name: 'DatasetEval' }],
      name: 'test-dataset',
      report_evaluators: [{ arguments: null, name: 'ReportEval' }],
    }
    const fetchImpl = fetchSequence(calls, [jsonResponse(hostedDataset), jsonResponse(exportPayload)])
    const client = new LogfireAPIClient({ apiKey: 'lf-api-key', baseUrl: 'https://example.com', fetch: fetchImpl })

    await expect(client.getDataset('test-dataset', { includeCases: false })).resolves.toEqual(hostedDataset)
    await expect(client.getDataset('test-dataset')).resolves.toEqual(exportPayload)

    expect(calls.map((call) => call.url)).toEqual([
      'https://example.com/v1/datasets/test-dataset/',
      'https://example.com/v1/datasets/test-dataset/export/',
    ])
  })

  it('supports case list, get, import, update, and delete endpoints', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [
      jsonResponse([hostedCase]),
      jsonResponse(hostedCase),
      jsonResponse([hostedCase]),
      jsonResponse({ ...hostedCase, name: null }),
      new Response(null, { status: 204 }),
    ])
    const client = new LogfireAPIClient({ apiKey: 'lf-api-key', baseUrl: 'https://example.com', fetch: fetchImpl })

    await expect(client.listCases('test-dataset')).resolves.toEqual([hostedCase])
    await expect(client.getCase('test-dataset', 'case-456')).resolves.toEqual(hostedCase)
    await expect(
      client.addCases(
        'test-dataset',
        [
          {
            evaluators: [{ arguments: null, name: 'CaseEval' }],
            expectedOutput: { answer: '4' },
            inputs: { question: 'What is 2+2?' },
            metadata: { source: 'seed' },
            name: 'arithmetic-1',
            tags: ['smoke'],
          },
        ],
        { onConflict: 'error' }
      )
    ).resolves.toEqual([hostedCase])
    await expect(client.updateCase('test-dataset', 'case-456', { expectedOutput: null, name: null })).resolves.toEqual({
      ...hostedCase,
      name: null,
    })
    await expect(client.deleteCase('test-dataset', 'case-456')).resolves.toBeUndefined()

    expect(calls.map((call) => call.url)).toEqual([
      'https://example.com/v1/datasets/test-dataset/cases/',
      'https://example.com/v1/datasets/test-dataset/cases/case-456/',
      'https://example.com/v1/datasets/test-dataset/import/?on_conflict=error',
      'https://example.com/v1/datasets/test-dataset/cases/case-456/',
      'https://example.com/v1/datasets/test-dataset/cases/case-456/',
    ])
    expect(calls[2]?.body).toEqual({
      cases: [
        {
          evaluators: [{ arguments: null, name: 'CaseEval' }],
          expected_output: { answer: '4' },
          inputs: { question: 'What is 2+2?' },
          metadata: { source: 'seed' },
          name: 'arithmetic-1',
          tags: ['smoke'],
        },
      ],
    })
    expect(calls[3]?.body).toEqual({
      expected_output: null,
      name: null,
    })
  })

  it('defaults case import onConflict to update', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [jsonResponse([hostedCase])])
    const client = new LogfireAPIClient({ apiKey: 'lf-api-key', baseUrl: 'https://example.com', fetch: fetchImpl })

    await client.addCases('test-dataset', [{ inputs: { question: 'q' } }])

    expect(calls[0]?.url).toBe('https://example.com/v1/datasets/test-dataset/import/?on_conflict=update')
  })

  it('supports dataset deletes', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [new Response(null, { status: 204 })])
    const client = new LogfireAPIClient({ apiKey: 'lf-api-key', baseUrl: 'https://example.com', fetch: fetchImpl })

    await expect(client.deleteDataset('test-dataset')).resolves.toBeUndefined()

    expect(calls[0]?.url).toBe('https://example.com/v1/datasets/test-dataset/')
    expect(calls[0]?.method).toBe('DELETE')
  })

  it('encodes dataset and case path segments', async () => {
    const calls: CapturedRequest[] = []
    const fetchImpl = fetchSequence(calls, [jsonResponse(hostedCase)])
    const client = new LogfireAPIClient({ apiKey: 'lf-api-key', baseUrl: 'https://example.com', fetch: fetchImpl })

    await client.getCase('dataset/name', 'case/name')

    expect(calls[0]?.url).toBe('https://example.com/v1/datasets/dataset%2Fname/cases/case%2Fname/')
  })

  it('maps 404 dataset and case responses to domain errors', async () => {
    const datasetClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse({ detail: 'Dataset not found' }, 404)]),
    })
    const caseClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse({ detail: 'Case not found' }, 404)]),
    })
    const missingDatasetFromCaseEndpointClient = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse({ detail: 'Not found' }, 404)]),
    })

    await expect(datasetClient.getDataset('missing')).rejects.toBeInstanceOf(DatasetNotFoundError)
    await expect(caseClient.getCase('test-dataset', 'missing')).rejects.toBeInstanceOf(CaseNotFoundError)
    await expect(missingDatasetFromCaseEndpointClient.getCase('missing-dataset', 'missing-case')).rejects.toBeInstanceOf(
      DatasetNotFoundError
    )
  })

  it('maps non-404 API errors with parsed details', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse({ detail: 'json_schema field required' }, 422)]),
    })

    await expect(client.createDataset({ name: 'bad' })).rejects.toMatchObject({
      detail: { detail: 'json_schema field required' },
      status: 422,
    } satisfies Partial<DatasetApiError>)
  })

  it('uses text fallback for API error details', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [new Response('plain failure', { status: 500 })]),
    })

    await expect(client.listDatasets()).rejects.toMatchObject({
      detail: 'plain failure',
      status: 500,
    } satisfies Partial<DatasetApiError>)
  })

  it('returns successful JSON responses without shape validation', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [jsonResponse({ not: 'an array' })]),
    })

    await expect(client.listDatasets()).resolves.toEqual({ not: 'an array' })
  })

  it('maps malformed successful JSON responses to transport errors', async () => {
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchSequence([], [new Response('not json', { status: 200 })]),
    })

    await expect(client.listDatasets()).rejects.toBeInstanceOf(DatasetTransportError)
  })

  it('maps timeouts to timeout errors', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    const client = new LogfireAPIClient({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      timeoutMs: 5,
    })

    const promise = client.listDatasets().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5)

    await expect(promise).resolves.toBeInstanceOf(DatasetTimeoutError)
  })

  it('requires an API key and a fetch implementation', () => {
    expect(() => new LogfireAPIClient({ apiKey: '' })).toThrow(DatasetConfigurationError)
    expect(() => new LogfireAPIClient({ apiKey: undefined as unknown as string })).toThrow('requires an API key')

    vi.stubGlobal('fetch', undefined)
    expect(() => new LogfireAPIClient({ apiKey: 'lf-api-key' })).toThrow(DatasetConfigurationError)
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
      headers: new Headers(init?.headers),
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
