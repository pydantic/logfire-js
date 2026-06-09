import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  configureVariables,
  defineVar,
  getVariableProvider,
  LocalVariableProvider,
  LogfireRemoteVariableProvider,
  targetingContext,
  var as logfireVar,
  VariableNotFoundError,
  VariableWriteError,
  variablesBuildConfig,
  variablesClear,
  variablesPullConfig,
  variablesPushConfig,
  variablesPushTypes,
  variablesValidate,
} from './vars'
import type { VariablesConfig } from './vars'

const config = (variables: VariablesConfig['variables']): VariablesConfig => ({ variables })

describe('managed variables', () => {
  beforeEach(() => {
    variablesClear()
    configureVariables(false)
  })

  afterEach(async () => {
    await getVariableProvider().shutdown?.()
    vi.restoreAllMocks()
    vi.useRealTimers()
    variablesClear()
    configureVariables(false)
  })

  it('resolves local variable labels and metadata', async () => {
    configureVariables({
      config: config({
        feature_enabled: {
          labels: { on: { serialized_value: 'true', version: 1 } },
          name: 'feature_enabled',
          overrides: [],
          rollout: { labels: { on: 1 } },
        },
      }),
      instrument: false,
    })

    const featureEnabled = logfireVar('feature_enabled', { default: false })

    const resolved = await featureEnabled.get()

    expect(resolved.value).toBe(true)
    expect(resolved.label).toBe('on')
    expect(resolved.version).toBe(1)
    expect(resolved.reason).toBe('resolved')
  })

  it('falls back to defaults for missing config and invalid values', async () => {
    configureVariables({
      config: config({
        count: {
          labels: { bad: { serialized_value: '"not-a-number"', version: 1 } },
          name: 'count',
          overrides: [],
          rollout: { labels: { bad: 1 } },
        },
      }),
      instrument: false,
    })

    const count = defineVar('count', { default: 3 })
    const missing = defineVar('missing', { default: 'fallback' })

    await expect(count.get()).resolves.toMatchObject({ label: 'bad', reason: 'validation_error', value: 3, version: 1 })
    await expect(missing.get()).resolves.toMatchObject({ reason: 'code_default', value: 'fallback' })
  })

  it('parses inferred object codecs', async () => {
    configureVariables({
      config: config({
        object_config: {
          labels: { remote: { serialized_value: '{"foo":"remote"}', version: 1 } },
          name: 'object_config',
          overrides: [],
          rollout: { labels: { remote: 1 } },
        },
      }),
      instrument: false,
    })

    const objectConfig = defineVar('object_config', { default: { foo: 'default' } })

    await expect(objectConfig.get()).resolves.toMatchObject({
      reason: 'resolved',
      value: { foo: 'remote' },
    })
  })

  it('supports explicit labels, label refs, and code defaults', async () => {
    configureVariables({
      config: config({
        color: {
          labels: {
            blue: { serialized_value: '"blue"', version: 1 },
            current: { ref: 'latest' },
            defaulted: { ref: 'code_default' },
          },
          latest_version: { serialized_value: '"green"', version: 2 },
          name: 'color',
          overrides: [],
          rollout: { labels: { blue: 1 } },
        },
      }),
      instrument: false,
    })

    const color = defineVar('color', { default: 'red' })

    await expect(color.get({ label: 'current' })).resolves.toMatchObject({ label: 'current', value: 'green', version: 2 })
    await expect(color.get({ label: 'defaulted' })).resolves.toMatchObject({ label: undefined, reason: 'code_default', value: 'red' })
  })

  it('falls back to contextual rollout when an explicit label is missing', async () => {
    configureVariables({
      config: config({
        mode: {
          labels: {
            control: { serialized_value: '"control"', version: 1 },
            premium: { serialized_value: '"premium"', version: 2 },
          },
          name: 'mode',
          overrides: [
            {
              conditions: [{ attribute: 'plan', kind: 'value-equals', value: 'pro' }],
              rollout: { labels: { premium: 1 } },
            },
          ],
          rollout: { labels: { control: 1 } },
        },
      }),
      instrument: false,
    })

    const mode = defineVar('mode', { default: 'default' })

    await expect(mode.get({ attributes: { plan: 'pro' }, label: 'missing' })).resolves.toMatchObject({
      label: 'premium',
      value: 'premium',
    })
  })

  it('falls back through providers without explicit label support', async () => {
    configureVariables(false)
    const disabled = defineVar('disabled_label', { default: 'fallback' })

    await expect(disabled.get({ label: 'missing' })).resolves.toMatchObject({
      reason: 'code_default',
      value: 'fallback',
    })
  })

  it('uses resource attributes, call attributes, targeting contexts, and overrides', async () => {
    const vars = config({
      mode: {
        labels: {
          control: { serialized_value: '"control"', version: 1 },
          premium: { serialized_value: '"premium"', version: 2 },
        },
        name: 'mode',
        overrides: [
          {
            conditions: [{ attribute: 'plan', kind: 'value-equals', value: 'pro' }],
            rollout: { labels: { premium: 1 } },
          },
        ],
        rollout: { labels: { control: 1 } },
      },
    })
    configureVariables({ config: vars, instrument: false }, { resourceAttributes: { plan: 'pro' } })
    const mode = defineVar('mode', {
      default: (targetingKey, attributes) => {
        const plan = attributes['plan']
        return `${targetingKey ?? 'none'}:${typeof plan === 'string' ? plan : 'unknown'}`
      },
      codec: { parse: (value) => (typeof value === 'string' ? value : JSON.stringify(value)) },
    })

    await expect(mode.get()).resolves.toMatchObject({ value: 'premium' })
    await expect(mode.get({ attributes: { plan: 'free' } })).resolves.toMatchObject({ value: 'control' })

    await expect(mode.override('override', async () => await mode.get())).resolves.toMatchObject({
      reason: 'context_override',
      value: 'override',
    })
    await targetingContext('user-123', async () => {
      const missing = defineVar('targeted_default', {
        default: (targetingKey) => targetingKey ?? 'none',
        codec: { parse: String },
      })
      await expect(missing.get()).resolves.toMatchObject({ value: 'user-123' })
    })
  })

  it('builds config and validates provider values with codecs', async () => {
    const feature = defineVar('feature', {
      default: { enabled: true },
      codec: {
        jsonSchema: {
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          type: 'object',
        },
        parse(value) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error('invalid feature')
          }
          const record = value as Record<string, unknown>
          if (typeof record['enabled'] !== 'boolean') {
            throw new Error('invalid feature')
          }
          return { enabled: record['enabled'] }
        },
      },
      description: 'Feature config',
    })

    expect(variablesBuildConfig([feature])).toEqual({
      variables: {
        feature: {
          description: 'Feature config',
          example: '{"enabled":true}',
          json_schema: {
            properties: { enabled: { type: 'boolean' } },
            required: ['enabled'],
            type: 'object',
          },
          labels: {},
          name: 'feature',
          overrides: [],
          rollout: { labels: {} },
          template_inputs_schema: null,
          type_name: null,
        },
      },
    })

    configureVariables({
      config: config({
        feature: {
          labels: { bad: { serialized_value: '{"enabled":"yes"}', version: 1 } },
          name: 'feature',
          overrides: [],
          rollout: { labels: { bad: 1 } },
        },
      }),
      instrument: false,
    })

    const report = await variablesValidate([feature])

    expect(report.isValid).toBe(false)
    expect(report.errors).toHaveLength(1)
    expect(report.variablesNotOnServer).toEqual([])
  })

  it('normalizes empty descriptions during validation', async () => {
    const emptyDescription = defineVar('empty_description', { default: false })
    configureVariables({
      config: config({
        empty_description: {
          description: '',
          labels: {},
          name: 'empty_description',
          overrides: [],
          rollout: { labels: {} },
        },
      }),
      instrument: false,
    })

    const report = await variablesValidate([emptyDescription])

    expect(report.descriptionDifferences).toEqual([])
  })

  it('pushes config changes to local providers', async () => {
    configureVariables({ config: config({}), instrument: false })

    const pushed = await variablesPushConfig(
      config({
        flag: {
          labels: { on: { serialized_value: 'true', version: 1 } },
          name: 'flag',
          overrides: [],
          rollout: { labels: { on: 1 } },
        },
      })
    )

    expect(pushed.changes).toEqual([{ action: 'create', name: 'flag' }])
    await expect(variablesPullConfig()).resolves.toMatchObject({
      variables: {
        flag: {
          name: 'flag',
        },
      },
    })
  })

  it('uses remote fetch with API key auth', async () => {
    const calls: { headers: HeadersInit | undefined; url: string }[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      await Promise.resolve()
      calls.push({ headers: init?.headers, url: requestInputToUrl(input) })
      return new Response(
        JSON.stringify(
          config({
            remote_flag: {
              labels: { on: { serialized_value: 'true', version: 1 } },
              name: 'remote_flag',
              overrides: [],
              rollout: { labels: { on: 1 } },
            },
          })
        ),
        { status: 200 }
      )
    })

    configureVariables({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com/',
      blockBeforeFirstResolve: true,
      fetch: fetchImpl,
      instrument: false,
      polling: false,
      sse: false,
    })
    const remoteFlag = defineVar('remote_flag', { default: false })

    await expect(remoteFlag.get()).resolves.toMatchObject({ value: true })
    expect(getVariableProvider()).toBeInstanceOf(LogfireRemoteVariableProvider)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://example.com/v1/variables/')
    expect(new Headers(calls[0]?.headers).get('Authorization')).toBe('bearer lf-api-key')
  })

  it('queues a forced refresh after an in-flight refresh', async () => {
    let resolveFirst: (() => void) | undefined
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (fetchImpl.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }
      return new Response(JSON.stringify(config({})), { status: 200 })
    })
    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: false,
    })

    const firstRefresh = provider.refresh()
    const forcedRefresh = provider.refresh(true)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(resolveFirst).toBeDefined()
    resolveFirst?.()
    await forcedRefresh
    await firstRefresh

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('omits empty labels from remote variable write bodies', async () => {
    const bodies: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await Promise.resolve()
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        bodies.push(parseJsonBody(init?.body))
      }
      return new Response(JSON.stringify(config({})), { status: method === 'POST' ? 201 : 200 })
    })
    configureVariables({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      blockBeforeFirstResolve: true,
      fetch: fetchImpl,
      instrument: false,
      polling: false,
      sse: false,
    })
    const flag = defineVar('empty_labels_remote', { default: false })

    await variablesPushConfig(variablesBuildConfig([flag]))

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('labels')
  })

  it('includes nullable schemas in remote create bodies', async () => {
    const bodies: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await Promise.resolve()
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        bodies.push(parseJsonBody(init?.body))
      }
      return new Response(JSON.stringify(config({})), { status: method === 'POST' ? 201 : 200 })
    })
    configureVariables({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      blockBeforeFirstResolve: true,
      fetch: fetchImpl,
      instrument: false,
      polling: false,
      sse: false,
    })

    await variablesPushConfig(
      config({
        no_schema_remote: {
          labels: {},
          name: 'no_schema_remote',
          overrides: [],
          rollout: { labels: {} },
        },
      })
    )

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toHaveProperty('json_schema', null)
  })

  it('includes response bodies in remote write errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await Promise.resolve()
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return new Response(JSON.stringify({ detail: 'json_schema field required' }), { status: 422 })
      }
      return new Response(JSON.stringify(config({})), { status: 200 })
    })
    configureVariables({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      blockBeforeFirstResolve: true,
      fetch: fetchImpl,
      instrument: false,
      polling: false,
      sse: false,
    })

    await expect(
      variablesPushConfig(
        config({
          rejected_remote: {
            labels: {},
            name: 'rejected_remote',
            overrides: [],
            rollout: { labels: {} },
          },
        })
      )
    ).rejects.toThrow('json_schema field required')
  })

  it('preserves remote delete 204 handling and not-found mapping', async () => {
    const calls: { method: string; url: string }[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      await Promise.resolve()
      const url = requestInputToUrl(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (url.endsWith('/missing_remote/')) {
        return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify(config({})), { status: 200 })
    })
    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com/',
      fetch: fetchImpl,
      polling: false,
      sse: false,
    })

    await provider.deleteVariable('old_remote')
    await expect(provider.deleteVariable('missing_remote')).rejects.toBeInstanceOf(VariableNotFoundError)

    expect(calls).toEqual([
      { method: 'DELETE', url: 'https://example.com/v1/variables/old_remote/' },
      { method: 'GET', url: 'https://example.com/v1/variables/' },
      { method: 'DELETE', url: 'https://example.com/v1/variables/missing_remote/' },
    ])
  })

  it('uses the shared platform transport timeout for remote variable JSON requests', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: false,
      timeoutMs: 5,
    })

    const refresh = provider.refresh(true).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5)
    const error = await refresh
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toContain('timed out')
  })

  it('strict variable type push blocks incompatible existing labels without mutating', async () => {
    const posts: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      await Promise.resolve()
      const url = requestInputToUrl(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/v1/variable-types/') && method === 'GET') {
        return new Response(JSON.stringify([{ json_schema: { type: 'number' }, name: 'answer_type' }]), { status: 200 })
      }
      if (url.endsWith('/v1/variables/') && method === 'GET') {
        return new Response(
          JSON.stringify(
            config({
              answer: {
                labels: { prod: { serialized_value: '42', version: 1 } },
                name: 'answer',
                overrides: [],
                rollout: { labels: { prod: 1 } },
                type_name: 'answer_type',
              },
            })
          ),
          { status: 200 }
        )
      }
      if (url.endsWith('/v1/variable-types/') && method === 'POST') {
        posts.push(parseJsonBody(init?.body))
        return new Response(JSON.stringify({}), { status: 200 })
      }
      return new Response(JSON.stringify(config({})), { status: 200 })
    })
    configureVariables({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      instrument: false,
      polling: false,
      sse: false,
    })

    await expect(variablesPushTypes([{ json_schema: { type: 'string' }, name: 'answer_type' }], { strict: true })).resolves.toEqual({
      blocked: true,
      blockedBy: ['incompatible_type_labels'],
      changes: [{ action: 'update', name: 'answer_type' }],
      dryRun: false,
    })
    expect(posts).toEqual([])
  })

  it('non-strict variable type push warns and applies incompatible existing labels', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const posts: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      await Promise.resolve()
      const url = requestInputToUrl(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/v1/variable-types/') && method === 'GET') {
        return new Response(JSON.stringify([{ json_schema: { type: 'number' }, name: 'answer_type' }]), { status: 200 })
      }
      if (url.endsWith('/v1/variables/') && method === 'GET') {
        return new Response(
          JSON.stringify(
            config({
              answer: {
                labels: { prod: { serialized_value: '42', version: 1 } },
                name: 'answer',
                overrides: [],
                rollout: { labels: { prod: 1 } },
                type_name: 'answer_type',
              },
            })
          ),
          { status: 200 }
        )
      }
      if (url.endsWith('/v1/variable-types/') && method === 'POST') {
        posts.push(parseJsonBody(init?.body))
        return new Response(JSON.stringify({}), { status: 200 })
      }
      return new Response(JSON.stringify(config({})), { status: 200 })
    })
    configureVariables({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      instrument: false,
      polling: false,
      sse: false,
    })

    await expect(variablesPushTypes([{ json_schema: { type: 'string' }, name: 'answer_type' }])).resolves.toEqual({
      blocked: false,
      blockedBy: [],
      changes: [{ action: 'update', name: 'answer_type' }],
      dryRun: false,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Variable type push label warning'))
    expect(posts).toEqual([{ description: null, json_schema: { type: 'string' }, name: 'answer_type', source_hint: null }])
  })

  it('wraps remote variable type listing failures as write errors', async () => {
    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com',
      fetch: async () => Promise.resolve(new Response(JSON.stringify({ detail: 'nope' }), { status: 503 })),
      polling: false,
      sse: false,
    })

    await expect(provider.listVariableTypes()).rejects.toBeInstanceOf(VariableWriteError)
    await expect(provider.listVariableTypes()).rejects.toThrow('Failed to list variable types')
  })

  it('keeps SSE requests on the event-stream fetch path', async () => {
    const calls: { headers: Headers; method: string; url: string }[] = []
    const fetchImpl = vi.fn<typeof fetch>(
      async (input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          calls.push({
            headers: new Headers(init?.headers),
            method: init?.method ?? 'GET',
            url: requestInputToUrl(input),
          })
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'lf-api-key',
      baseUrl: 'https://example.com/',
      fetch: fetchImpl,
      polling: false,
      sse: true,
    })

    provider.start()
    await waitFor(() => calls.length > 0)
    provider.shutdown()

    expect(calls[0]?.url).toBe('https://example.com/v1/variable-updates/')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers.get('Accept')).toBe('text/event-stream')
    expect(calls[0]?.headers.get('Authorization')).toBe('bearer lf-api-key')
    expect(calls[0]?.headers.get('Content-Type')).toBeNull()
  })

  it('can disable variables explicitly', () => {
    configureVariables(false)

    expect(getVariableProvider()).not.toBeInstanceOf(LocalVariableProvider)
  })
})

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) {
    return undefined
  }
  if (typeof body !== 'string') {
    throw new Error('Expected string request body')
  }
  return JSON.parse(body)
}

async function waitFor(predicate: () => boolean, attempts: number = 20): Promise<void> {
  if (predicate()) {
    return
  }
  if (attempts <= 0) {
    throw new Error('Timed out waiting for condition')
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await waitFor(predicate, attempts - 1)
}
