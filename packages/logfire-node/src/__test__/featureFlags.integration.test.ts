import { once } from 'node:events'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { context, propagation, trace, TraceFlags } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { defineVar, getVariableProvider, LocalVariableProvider, variablesClear } from 'logfire/vars'
import type { VariableConfig } from 'logfire/vars'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'

import { defineFlag, withFeatureContext } from '../featureFlags'
import { configure, shutdown, span } from '../index'

const base = { console: false as const, metrics: false as const, sendToLogfire: false }

const checkout: VariableConfig = {
  name: 'checkout',
  aliases: ['checkout_alias'],
  labels: {
    on: { serialized_value: 'true', version: 2 },
    off: { serialized_value: 'false', version: 1 },
  },
  rollout: { labels: { on: 0.25, off: 0.5 } },
  overrides: [],
  experiment_revision: 'fixture-revision',
}

function singleValue(name: string, value: unknown): VariableConfig {
  return {
    name,
    labels: { active: { serialized_value: JSON.stringify(value), version: 1 } },
    rollout: { labels: { active: 1 } },
    overrides: [],
  }
}

function configureLocal(variables: VariableConfig[], processor?: SpanProcessor) {
  configure({
    ...base,
    variables: { config: { variables: Object.fromEntries(variables.map((variable) => [variable.name, variable])) } },
    ...(processor === undefined ? {} : { additionalSpanProcessors: [processor] }),
  })
}

describe('experimental feature flags', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await shutdown()
    variablesClear()
  })

  // The Python column was generated with Python's Random(repr(name) + ':' + repr(key)).
  // These fixtures identify the drift until the services share an assignment contract.
  it.each([
    ['account-1', undefined, 'on'],
    ['account-3', 'off', undefined],
    ['élève', undefined, 'off'],
    ['a:b', 'off', 'off'],
    ['🧪', 'off', 'on'],
  ] as const)('pins Node assignment for %s (JS %s, Python %s)', async (key, variant, _pythonVariant) => {
    configureLocal([checkout])
    const flag = defineFlag('checkout_alias', { default: true })
    const legacy = defineVar('checkout', { default: true })
    const details = await flag.details({ targetingKey: key })
    expect((await legacy.get({ targetingKey: key })).label).toBe(variant)
    expect(details).toEqual({
      flagKey: 'checkout',
      reason: variant === undefined ? 'default' : 'split',
      value: variant === undefined,
      ...(variant === undefined ? {} : { variant, valueVersion: 1 }),
    })
  })

  it('distinguishes the latest configured version from an unallocated code default', async () => {
    configureLocal([
      {
        ...checkout,
        latest_version: { serialized_value: 'false', version: 3 },
        labels: { latest: { ref: 'latest' } },
        rollout: { labels: { latest: 1 } },
      },
      { ...checkout, name: 'unallocated', aliases: [], rollout: { labels: {} } },
    ])
    expect(await defineFlag('checkout', { default: true }).details()).toEqual({
      flagKey: 'checkout',
      reason: 'static',
      variant: 'latest',
      value: false,
      valueVersion: 3,
    })
    expect(await defineFlag('unallocated', { default: true }).details()).toEqual({
      flagKey: 'unallocated',
      reason: 'default',
      value: true,
    })
  })

  it('uses the declared default when a split has neither a targeting key nor an active scope', async () => {
    configureLocal([checkout, singleValue('banner', true)])
    const flag = defineFlag('checkout', { default: true })
    expect(await flag.details()).toEqual({
      flagKey: 'checkout',
      reason: 'error',
      errorCode: 'targeting_key_missing',
      value: true,
    })
    expect(await defineFlag('banner', { default: false }).value()).toBe(true)
  })

  it('keeps unkeyed reads and typed references on one key inside local root spans', async () => {
    configureLocal([checkout, singleValue('prompt', 'Enabled: @{checkout}@')])
    const checkoutFlag = defineFlag('checkout', { default: false })
    const prompt = defineFlag('prompt', { default: '' })
    const lookups = vi.spyOn(LocalVariableProvider.prototype, 'getSerializedValue')
    const remoteParent = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    }
    const inbound = trace.setSpanContext(context.active(), remoteParent)
    const read = async () => {
      const [first, second, third, composed] = await Promise.all([
        withFeatureContext({}, async () => checkoutFlag.value()),
        span('nested', { callback: async () => checkoutFlag.value() }),
        checkoutFlag.value(),
        prompt.value(),
      ])
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(composed).toBe(`Enabled: ${String(first)}`)
    }
    await context.with(inbound, async () => span('request', { callback: read }))
    await context.with(inbound, async () => span('another request', { callback: read }))
    const keys = lookups.mock.calls.filter(([name]) => name === 'checkout').map(([, key]) => key)
    expect(keys).toHaveLength(8)
    expect(keys[0]).toMatch(/^anonymous:/u)
    expect(new Set(keys.slice(0, 4)).size).toBe(1)
    expect(new Set(keys.slice(4)).size).toBe(1)
    expect(keys[0]).not.toBe(keys[4])
  })

  it('isolates concurrent scopes, honors explicit attributes, and ignores inbound baggage', async () => {
    configureLocal([
      {
        ...singleValue('assistant', false),
        labels: { on: { serialized_value: 'true', version: 2 }, off: { serialized_value: 'false', version: 1 } },
        rollout: { labels: { off: 1 } },
        overrides: [
          {
            conditions: [{ kind: 'value-equals', attribute: 'plan', value: 'team' }],
            rollout: { labels: { on: 1 } },
          },
        ],
      },
    ])
    const assistant = defineFlag('assistant', { default: false })
    const inbound = propagation.setBaggage(context.active(), propagation.createBaggage({ plan: { value: 'team' } }))
    expect(await context.with(inbound, async () => assistant.value())).toBe(false)
    const [team, free] = await Promise.all([
      withFeatureContext({ targetingKey: 'team-1', attributes: { plan: 'team' } }, async () => {
        await Promise.resolve()
        const automatic = await assistant.details()
        const explicit = await assistant.value({ attributes: { plan: 'free' } })
        return [automatic.reason, automatic.value, explicit]
      }),
      withFeatureContext({ targetingKey: 'free-1', attributes: { plan: 'free' } }, async () => assistant.value()),
    ])
    expect(team).toEqual(['targeting_match', true, false])
    expect(free).toBe(false)
    expect(await assistant.value()).toBe(false)
  })

  it('infers schema output, composes remote values, and isolates and validates overrides', async () => {
    configureLocal([
      singleValue('brand', 'Acme'),
      singleValue('policy', { brand: '@{brand}@', limit: 3 }),
      singleValue('invalid_policy', { brand: 'Acme', limit: 9 }),
      singleValue('prompt', '@{policy.limit}@ / @{invalid_policy.limit}@'),
    ])
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(input: unknown) {
          if (
            typeof input === 'object' &&
            input !== null &&
            'brand' in input &&
            'limit' in input &&
            typeof input.brand === 'string' &&
            typeof input.limit === 'number' &&
            input.limit > 0 &&
            input.limit <= 5
          ) {
            return { value: { brand: input.brand, limit: input.limit } }
          }
          return { issues: [{ message: 'invalid policy' }] }
        },
      },
    }
    const policy = defineFlag('policy', { default: { brand: '@{literal}@', limit: 1 }, schema })
    const invalid = defineFlag('invalid_policy', { default: { brand: 'Safe', limit: 1 }, schema })
    const prompt = defineFlag('prompt', { default: 'fallback' })
    expectTypeOf(policy.value()).toEqualTypeOf<Promise<{ brand: string; limit: number }>>()
    expect(await policy.value()).toEqual({ brand: 'Acme', limit: 3 })
    expect(await invalid.details()).toEqual({
      flagKey: 'invalid_policy',
      reason: 'error',
      errorCode: 'type_mismatch',
      value: { brand: 'Safe', limit: 1 },
    })
    expect(await prompt.value()).toBe('fallback')
    expect(() => {
      policy.override({ brand: 'invalid', limit: 9 }, () => undefined)
    }).toThrow(TypeError)
    const [overridden, normal] = await Promise.all([
      policy.override({ brand: '@{literal}@', limit: 4 }, async () => {
        await expect(policy.override({ brand: 'nested', limit: 5 }, async () => policy.value())).resolves.toEqual({
          brand: 'nested',
          limit: 5,
        })
        return policy.value()
      }),
      policy.value(),
    ])
    expect(overridden).toEqual({ brand: '@{literal}@', limit: 4 })
    expect(normal).toEqual({ brand: 'Acme', limit: 3 })
    expect(() => defineFlag('bad_default', { default: { brand: 'Acme', limit: 0 }, schema })).toThrow(TypeError)
  })

  it('records bounded declarations and eligible evaluations without exporting the context', async () => {
    const spans: ReadableSpan[] = []
    configureLocal([checkout], {
      forceFlush: async () => Promise.resolve(),
      onStart: () => undefined,
      onEnd: (span) => {
        spans.push(span)
      },
      shutdown: async () => Promise.resolve(),
    })
    const flag = defineFlag('checkout', { default: false })
    await flag.details({ targetingKey: 'account-3', attributes: { identity: 'should-not-leave-process' } })
    await flag.override(true, async () => flag.details({ targetingKey: 'account-3' }))
    await span('anonymous', { callback: async () => flag.value() })
    const recorded = spans.filter((item) => item.attributes['logfire.span_type'] !== 'pending_span')
    const declarations = recorded.filter((item) => item.name === 'Declare variable checkout')
    expect(declarations).toHaveLength(1)
    expect(declarations[0]?.attributes['logfire.variable.code_default']).toBe('false')
    const evaluations = recorded.filter((item) => item.name === 'feature_flag.evaluation')
    expect(evaluations.map((item) => item.attributes['logfire.feature_flag.experiment_revision'])).toEqual([
      'fixture-revision',
      undefined,
      undefined,
    ])
    expect(evaluations[0]?.attributes['feature_flag.result.variant']).toBe('off')
    expect(JSON.stringify(evaluations.map((item) => item.attributes))).not.toMatch(/account-3|should-not-leave-process|anonymous:/u)
  })

  it('loads remote flags over HTTP and picks up SSE updates and refresh recovery', async () => {
    let config = singleValue('published', true)
    let requests = 0
    let status = 503
    let eventStream: ServerResponse | undefined
    const server = createServer((request, response) => {
      if (request.url === '/v1/variable-updates/') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()
        eventStream = response
        return
      }
      requests++
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(status === 200 ? { variables: { published: config } } : { error: 'Unavailable' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${String(address.port)}`
      configure({ ...base, apiKey: 'test-read-key', advanced: { baseUrl }, variables: { polling: false } })
      const flag = defineFlag('published', { default: false })
      const missing = await Promise.all([flag.details(), flag.details(), flag.details()])
      expect(missing.map((item) => item.errorCode)).toEqual(['general', 'general', 'general'])
      expect(requests).toBe(1)
      status = 200
      await vi.waitFor(() => {
        expect(eventStream).toBeDefined()
      })
      eventStream?.write('data: {"event":"updated"}\n\n')
      await vi.waitFor(async () => {
        expect(await flag.value()).toBe(true)
      })
      const cachedRequests = requests
      expect(await flag.value()).toBe(true)
      expect(requests).toBe(cachedRequests)
      status = 503
      const provider = getVariableProvider()
      await expect(provider.refresh?.(true)).rejects.toThrow(/503/u)
      expect(await flag.details()).toMatchObject({ reason: 'stale', value: true })
      status = 200
      config = singleValue('published', 'invalid')
      await provider.refresh?.(true)
      expect(await flag.details()).toMatchObject({ reason: 'error', errorCode: 'type_mismatch', value: false })
      config = singleValue('published', true)
      await provider.refresh?.(true)
      expect(await flag.details()).toMatchObject({ reason: 'static', value: true })
    } finally {
      await shutdown()
      eventStream?.end()
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  })
})
