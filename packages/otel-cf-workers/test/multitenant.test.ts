/// <reference types="@cloudflare/workers-types" />

import { trace } from '@opentelemetry/api'
import { CompositePropagator } from '@opentelemetry/core'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, describe, expect, it, vitest } from 'vitest'

import { instrument } from '../src/sdk'
import type { ResolveConfigFn } from '../src/sdk'

const exporters = {
  a: new InMemorySpanExporter(),
  b: new InMemorySpanExporter(),
}

type Tenant = keyof typeof exporters

function tenantOf(trigger: unknown): Tenant {
  return trigger instanceof Request && trigger.headers.get('x-tenant') === 'b' ? 'b' : 'a'
}

const resolveConfig: ResolveConfigFn = (_env, trigger) => {
  const tenant = tenantOf(trigger)
  return {
    exporter: exporters[tenant],
    service: { name: `service-${tenant}` },
    // Tenant B does not accept inbound trace context, so its propagator extracts nothing.
    ...(tenant === 'b' ? { propagator: new CompositePropagator() } : {}),
    instrumentation: { instrumentGlobalCache: false, instrumentGlobalFetch: false },
  }
}

const handler = instrument(
  {
    async fetch(request: Request): Promise<Response> {
      const tenant = request.headers.get('x-tenant') ?? 'a'
      // Crossing an await checks that the request's config survives async continuations.
      await trace.getTracer('app').startActiveSpan(`work ${tenant}`, async (span) => {
        await Promise.resolve()
        span.end()
      })
      return new Response(tenant)
    },
  },
  resolveConfig
)

const INBOUND_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'

async function send(tenant: Tenant): Promise<void> {
  const waitUntilPromises: Promise<unknown>[] = []
  const ctx = {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
  } as unknown as ExecutionContext
  const request = new Request('https://example.com/', {
    headers: { 'x-tenant': tenant, traceparent: `00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01` },
  })
  const fetch = handler.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>
  await fetch(request, {}, ctx)
  await Promise.all(waitUntilPromises)
}

beforeAll(() => {
  vitest.stubGlobal('scheduler', { wait: async () => Promise.resolve() })
})

afterAll(() => {
  vitest.unstubAllGlobals()
})

describe('per-request config isolation', () => {
  it('exports each request only to the exporter, resource and propagator from its own config', async () => {
    await send('a')
    await send('b')
    await send('a')

    const spansA = exporters.a.getFinishedSpans()
    const spansB = exporters.b.getFinishedSpans()

    expect(spansA.map((span) => span.name)).toEqual(['work a', 'fetchHandler GET /', 'work a', 'fetchHandler GET /'])
    expect(spansB.map((span) => span.name)).toEqual(['work b', 'fetchHandler GET /'])

    expect(new Set(spansA.map((span) => span.resource.attributes['service.name']))).toEqual(new Set(['service-a']))
    expect(new Set(spansB.map((span) => span.resource.attributes['service.name']))).toEqual(new Set(['service-b']))

    expect(new Set(spansA.map((span) => span.spanContext().traceId))).toEqual(new Set([INBOUND_TRACE_ID]))
    expect(spansB.some((span) => span.spanContext().traceId === INBOUND_TRACE_ID)).toBe(false)
  })
})
