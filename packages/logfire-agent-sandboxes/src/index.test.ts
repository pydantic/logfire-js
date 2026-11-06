import type { ServerDuplexStream, ServerErrorResponse } from '@grpc/grpc-js'

import { Metadata, Server, ServerCredentials, status } from '@grpc/grpc-js'
import { context, propagation, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { MontyRefusedError } from '@pydantic/monty'
import { findMontyBinary } from '@pydantic/monty/node'
import { spawn } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { agentSandboxes } from './index'

interface SessionRequest {
  metadata: Record<string, string>
  path: string
}

const SESSION_PATH = '/monty.v1.MontySession/Session'
const identity = (buffer: Buffer): Buffer => buffer

// A local stand-in for the agent sandboxes server. It serves the Monty session RPC over raw bytes, records the
// path and metadata of each stream, and relays each stream to a local `monty subprocess` worker. The worker
// reads and writes protobuf messages framed with a little-endian 4-byte length prefix.
let server: Server
let serverUrl: string
let refusal: ServerErrorResponse | undefined
const requests: SessionRequest[] = []

function relay(stream: ServerDuplexStream<Buffer, Buffer>): void {
  const metadata: Record<string, string> = {}
  for (const [name, value] of Object.entries(stream.metadata.getMap())) {
    if (typeof value === 'string') {
      metadata[name] = value
    }
  }
  requests.push({ metadata, path: stream.getPath() })
  if (refusal !== undefined) {
    stream.emit('error', refusal)
    return
  }
  // The client sends nothing until the server admits the stream with its response headers.
  stream.sendMetadata(new Metadata())

  const worker = spawn(findMontyBinary(), ['subprocess'], { stdio: ['pipe', 'pipe', 'inherit'] })
  stream.on('data', (message: Buffer) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(message.length)
    worker.stdin.write(Buffer.concat([prefix, message]))
  })
  stream.on('end', () => {
    worker.stdin.end()
  })
  stream.on('close', () => {
    worker.kill()
  })
  stream.on('error', () => {
    worker.kill()
  })

  let pending = Buffer.alloc(0)
  worker.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = pending.readUInt32LE(0)
      stream.write(pending.subarray(4, 4 + size))
      pending = pending.subarray(4 + size)
    }
  })
  worker.on('exit', () => {
    stream.end()
  })
}

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  server = new Server()
  server.addService(
    {
      Session: {
        path: SESSION_PATH,
        requestDeserialize: identity,
        requestSerialize: identity,
        requestStream: true,
        responseDeserialize: identity,
        responseSerialize: identity,
        responseStream: true,
      },
    },
    { Session: relay }
  )
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error === null) {
        resolve(bound)
      } else {
        reject(error)
      }
    })
  })
  serverUrl = `http://127.0.0.1:${String(port)}`
})

afterAll(() => {
  server.forceShutdown()
  context.disable()
  propagation.disable()
})

afterEach(() => {
  requests.length = 0
  refusal = undefined
  vi.unstubAllEnvs()
})

async function runOneSession(options: Parameters<typeof agentSandboxes>[0]): Promise<SessionRequest> {
  await using pool = await agentSandboxes(options)
  await using session = await pool.checkout()
  expect(await session.feedRun('1 + 1')).toBe(2)
  expect(requests).toHaveLength(1)
  return requests[0] as SessionRequest
}

describe('agentSandboxes', () => {
  /** Real gRPC statuses and policy trailers must reach callers as typed Monty refusals with actionable Logfire hints. */
  it.each([
    ['UNAUTHENTICATED', 'unauthenticated', 'unauthenticated'],
    ['PERMISSION_DENIED', 'permission denied', 'permission_denied'],
    ['RESOURCE_EXHAUSTED', 'assignment attempt rate exceeded', 'caller_cap'],
    ['RESOURCE_EXHAUSTED', 'at capacity', 'capacity'],
  ] as const)('adds hints to a gRPC %s refusal: %s (%s)', async (statusCode, details, cause) => {
    const metadata = new Metadata()
    metadata.set('monty-cause', cause)
    refusal = Object.assign(new Error(details), { code: status[statusCode], details, metadata })
    await using pool = await agentSandboxes({ apiKey: 'test-key', url: serverUrl })
    const error = await pool.checkout().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(MontyRefusedError)
    expect(error).toMatchObject({ cause, statusCode, statusMessage: details })
    expect((error as Error).message.split('\n\n')[0]).toBe(
      `RuntimeError: failed to spawn monty worker: ${serverUrl}: ${statusCode}: ${details}`
    )
    expect((error as Error).message.includes('\n\nLogfire Agent Sandboxes: ')).toBe(true)
  })

  it('throws without an API key', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', '')
    await expect(agentSandboxes()).rejects.toThrow(
      'Agent sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. ' +
        'Set the LOGFIRE_API_KEY environment variable or pass `apiKey` to `agentSandboxes()`.'
    )
  })

  it('opens the session stream at the root of LOGFIRE_BASE_URL with the LOGFIRE_API_KEY bearer token', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', 'env-key')
    vi.stubEnv('LOGFIRE_BASE_URL', `${serverUrl}/`)
    const request = await runOneSession({})
    expect(request.path).toBe(SESSION_PATH)
    expect(request.metadata['authorization']).toBe('Bearer env-key')
  })

  it('prefers the apiKey and url options', async () => {
    vi.stubEnv('LOGFIRE_API_KEY', 'env-key')
    vi.stubEnv('LOGFIRE_BASE_URL', 'http://127.0.0.1:1')
    const request = await runOneSession({ apiKey: 'option-key', url: serverUrl })
    expect(request.metadata['authorization']).toBe('Bearer option-key')
  })

  /** Both URL sources must fail at pool creation, before a checkout can connect to a misconfigured endpoint. */
  it.each(['/monty-ws/', '/other', '?region=us', '#sandbox'])(
    'rejects %s in url and LOGFIRE_BASE_URL before connecting',
    async (suffix) => {
      vi.stubEnv('LOGFIRE_BASE_URL', `${serverUrl}${suffix}`)
      const expected = new Error(
        'Agent Sandboxes URL must use http://<host> or https://<host> with no path, query or fragment. ' +
          'Remove the old /monty-ws/ path from `url` or LOGFIRE_BASE_URL.'
      )
      await expect(agentSandboxes({ apiKey: 'option-key' })).rejects.toThrow(expected)
      vi.stubEnv('LOGFIRE_BASE_URL', serverUrl)
      await expect(agentSandboxes({ apiKey: 'option-key', url: `${serverUrl}${suffix}` })).rejects.toThrow(expected)
      expect(requests).toEqual([])
    }
  )

  it.each(['Authorization', 'authorization', 'aUtHoRiZaTiOn'])('lets metadata replace the %s entry', async (name) => {
    const request = await runOneSession({
      apiKey: 'option-key',
      metadata: async () => await Promise.resolve({ [name]: 'Bearer user-token', 'X-Extra': 'extra' }),
      url: serverUrl,
    })
    expect(request.metadata['authorization']).toBe('Bearer user-token')
    expect(request.metadata['x-extra']).toBe('extra')
  })

  it('accepts the deprecated connectHeaders name', async () => {
    const request = await runOneSession({
      apiKey: 'option-key',
      connectHeaders: () => ({ 'X-Extra': 'extra' }),
      url: serverUrl,
    })
    expect(request.metadata['authorization']).toBe('Bearer option-key')
    expect(request.metadata['x-extra']).toBe('extra')
  })

  it('rejects both metadata and connectHeaders', async () => {
    await expect(
      agentSandboxes({ apiKey: 'option-key', connectHeaders: () => ({}), metadata: () => ({}), url: serverUrl })
    ).rejects.toThrow(new TypeError('pass metadata, not connectHeaders as well'))
  })

  it('sends the trace context active at checkout', async () => {
    await using pool = await agentSandboxes({ apiKey: 'option-key', url: serverUrl })
    const spanContext = {
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    }
    await using session = await context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), async () => pool.checkout())
    expect(await session.feedRun('x = 20')).toBe(null)
    expect(await session.feedRun('x + 22')).toBe(42)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.metadata['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
  })

  it('sends no trace context outside a span', async () => {
    const request = await runOneSession({ apiKey: 'option-key', url: serverUrl })
    expect(request.metadata['traceparent']).toBeUndefined()
  })
})
