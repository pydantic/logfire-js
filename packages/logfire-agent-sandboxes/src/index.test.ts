import type { IncomingHttpHeaders, Server } from 'node:http'

import { context, propagation, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { agentSandboxes } from './index'

interface UpgradeRequest {
  headers: IncomingHttpHeaders
  url: string | undefined
}

// Rejects every WebSocket upgrade after recording it, so a checkout shows exactly what was dialed
// without needing a real sandboxes server.
let server: Server
let serverUrl: string
const upgrades: UpgradeRequest[] = []

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  server = createServer()
  server.on('upgrade', (req, socket) => {
    upgrades.push({ headers: req.headers, url: req.url })
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  serverUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve)
  })
  context.disable()
  propagation.disable()
})

afterEach(() => {
  upgrades.length = 0
  vi.unstubAllEnvs()
})

async function checkoutUpgrade(checkout: () => Promise<unknown>): Promise<UpgradeRequest> {
  await expect(checkout()).rejects.toThrow('HTTP error: 401 Unauthorized')
  expect(upgrades).toHaveLength(1)
  return upgrades[0] as UpgradeRequest
}

describe('agentSandboxes', () => {
  it('throws without an API key', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', '')
    await expect(agentSandboxes()).rejects.toThrow(
      'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
        'Set the LOGFIRE_API_KEY environment variable or pass `apiKey` to `agentSandboxes()`.'
    )
  })

  it('dials the sandboxes path of LOGFIRE_BASE_URL with the LOGFIRE_API_KEY bearer token', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', 'env-key')
    vi.stubEnv('LOGFIRE_BASE_URL', `${serverUrl}/`)
    await using pool = await agentSandboxes()
    const upgrade = await checkoutUpgrade(async () => pool.checkout())
    expect(upgrade.url).toBe('/monty-ws/')
    expect(upgrade.headers.authorization).toBe('Bearer env-key')
  })

  it('prefers the apiKey and url options', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', 'env-key')
    await using pool = await agentSandboxes({ apiKey: 'option-key', url: `${serverUrl.replace('http', 'ws')}/custom/` })
    const upgrade = await checkoutUpgrade(async () => pool.checkout())
    expect(upgrade.url).toBe('/custom/')
    expect(upgrade.headers.authorization).toBe('Bearer option-key')
  })

  it('merges connectHeaders over the Logfire headers', async () => {
    await using pool = await agentSandboxes({
      apiKey: 'option-key',
      connectHeaders: async () => await Promise.resolve({ Authorization: 'Bearer user-token', 'X-Extra': 'extra' }),
      url: serverUrl.replace('http', 'ws'),
    })
    const upgrade = await checkoutUpgrade(async () => pool.checkout())
    expect(upgrade.headers.authorization).toBe('Bearer user-token')
    expect(upgrade.headers['x-extra']).toBe('extra')
  })

  it('sends the trace context active at checkout', async () => {
    await using pool = await agentSandboxes({ apiKey: 'option-key', url: serverUrl.replace('http', 'ws') })
    const spanContext = {
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    }
    const upgrade = await checkoutUpgrade(async () =>
      context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), async () => pool.checkout())
    )
    expect(upgrade.headers['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
  })

  it('sends no trace context outside a span', async () => {
    await using pool = await agentSandboxes({ apiKey: 'option-key', url: serverUrl.replace('http', 'ws') })
    const upgrade = await checkoutUpgrade(async () => pool.checkout())
    expect(upgrade.headers['traceparent']).toBeUndefined()
  })
})
