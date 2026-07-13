import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type express from 'express'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { DevelopmentProxyConfig } from './proxySupport.ts'

interface ProxyContract {
  createProxyApp: (config: DevelopmentProxyConfig) => express.Express
  defaultOrigin: string
  defaultOrigins: readonly string[]
  defaultPort: number
  label: string
  loadProxyConfig: (env?: NodeJS.ProcessEnv) => DevelopmentProxyConfig
  startProxy: (config?: DevelopmentProxyConfig) => Promise<Server>
  verifyExampleApi: (origin: string) => Promise<void>
}

interface Receipt {
  body: Buffer
  headers: IncomingHttpHeaders
  method: string
  url: string
}

interface RawResponse {
  body: string
  headers: IncomingHttpHeaders
  status: number
}

export function defineProxyContract(contract: ProxyContract): void {
  const servers = new Set<Server>()

  afterEach(async () => {
    await Promise.all([...servers].map(async (server) => closeServer(server)))
    servers.clear()
    vi.restoreAllMocks()
  })

  describe(`${contract.label} development proxy`, () => {
    it('loads safe literal defaults and rejects invalid security configuration', () => {
      const defaults = contract.loadProxyConfig({ LOGFIRE_TOKEN: 'sentinel-token' })
      expect(defaults).toEqual({
        allowedOrigins: contract.defaultOrigins,
        bodyLimitBytes: 10 * 1024 * 1024,
        host: '127.0.0.1',
        logfireMetricsUrl: 'https://logfire-api.pydantic.dev/v1/metrics',
        logfireReplayUrl: 'https://logfire-api.pydantic.dev/v1/replay',
        logfireUrl: 'https://logfire-api.pydantic.dev/v1/traces',
        port: contract.defaultPort,
        token: 'sentinel-token',
      })

      expect(() => contract.loadProxyConfig({})).toThrow('LOGFIRE_TOKEN is required')
      expect(() => contract.loadProxyConfig({ HOST: '0.0.0.0', LOGFIRE_TOKEN: 'sentinel-token' })).toThrow('HOST must be 127.0.0.1')
      expect(() =>
        contract.loadProxyConfig({
          LOGFIRE_TOKEN: 'sentinel-token',
          LOGFIRE_URL: 'http://127.0.0.1:3000/custom-traces',
        })
      ).toThrow('LOGFIRE_METRICS_URL is required when LOGFIRE_URL does not end in /v1/traces')
      expect(() =>
        contract.loadProxyConfig({
          LOGFIRE_TOKEN: 'sentinel-token',
          LOGFIRE_REPLAY_URL: 'http://127.0.0.1:3000/v1/replay?tenant=demo',
        })
      ).toThrow('LOGFIRE_REPLAY_URL must be an absolute http(s) URL without credentials, a query, or a fragment')
      for (const value of [
        '',
        '*',
        'http://127.0.0.1:5173/',
        'http://127.0.0.1:5173/path',
        'http://127.0.0.1:5173?query=1',
        'https://user@example.com',
        'ftp://127.0.0.1',
        'http://*.example.com',
        'http://127.0.0.1:5173,http://127.0.0.1:5173',
        Array.from({ length: 17 }, (_, index) => `http://127.0.0.1:${6000 + index}`).join(','),
      ]) {
        expect(() =>
          contract.loadProxyConfig({
            LOGFIRE_ALLOWED_ORIGINS: value,
            LOGFIRE_TOKEN: 'sentinel-token',
          })
        ).toThrow()
      }
    })

    it('binds the default listener to loopback', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const config = { ...contract.loadProxyConfig({ LOGFIRE_TOKEN: 'sentinel-token' }), port: 0 }
      const server = await contract.startProxy(config)
      servers.add(server)
      const address = server.address() as AddressInfo
      expect(address.address).toBe('127.0.0.1')
    })

    it('forwards trace, metric, and encoded replay requests byte-for-byte with bounded headers', async () => {
      const fake = await startFakeUpstream(servers)
      const proxy = await startProxyApp(contract, fake.origin, servers)
      const cases = [
        {
          body: '{"trace":true}',
          contentEncoding: undefined,
          contentType: 'application/json',
          path: '/client-traces',
          upstream: '/v1/traces',
        },
        {
          body: 'raw-trace-bytes',
          contentEncoding: undefined,
          contentType: undefined,
          path: '/client-traces',
          upstream: '/v1/traces',
        },
        {
          body: '{"metric":true}',
          contentEncoding: undefined,
          contentType: 'application/json',
          path: '/client-metrics',
          upstream: '/v1/metrics',
        },
        {
          body: 'gzip-replay-bytes',
          contentEncoding: 'gzip',
          contentType: 'application/json',
          path: '/client-replay/session%2Fspace%20%C3%A9%3F?seq=1%26next%3D2',
          upstream: '/v1/replay/session%2Fspace%20%C3%A9%3F?seq=1%26next%3D2',
        },
      ] as const

      for (const testCase of cases) {
        const response = await fetch(`${proxy.origin}${testCase.path}`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer browser-token',
            Cookie: 'session=browser-secret',
            'X-CSRF': 'csrf-secret',
            'X-Forwarded-For': '203.0.113.1',
            'X-Logfire-Example': 'browser-rum-replay',
            ...(testCase.contentEncoding === undefined ? {} : { 'Content-Encoding': testCase.contentEncoding }),
            ...(testCase.contentType === undefined ? {} : { 'Content-Type': testCase.contentType }),
          },
          body: Buffer.from(testCase.body),
        })
        expect(response.status).toBe(201)
        expect(await response.text()).toBe('{"accepted":true}')
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(response.headers.get('set-cookie')).toBeNull()

        const receipt = fake.receipts.at(-1)
        expect(receipt?.method).toBe('POST')
        expect(receipt?.url).toBe(testCase.upstream)
        expect(receipt?.body.toString('utf8')).toBe(testCase.body)
        expect(receipt?.headers.authorization).toBe('Bearer sentinel-token')
        expect(receipt?.headers['content-type']).toBe(testCase.contentType)
        expect(receipt?.headers['content-encoding']).toBe(testCase.contentEncoding)
        expect(receipt?.headers.cookie).toBeUndefined()
        expect(receipt?.headers['x-csrf']).toBeUndefined()
        expect(receipt?.headers['x-forwarded-for']).toBeUndefined()
        expect(receipt?.headers['x-logfire-example']).toBeUndefined()
      }
    })

    it('enforces allowed and rejected Origin policy on every forwarding route', async () => {
      const fake = await startFakeUpstream(servers)
      const proxy = await startProxyApp(contract, fake.origin, servers)
      const paths = ['/client-traces', '/client-metrics', '/client-replay/session?seq=0']

      for (const path of paths) {
        for (const origin of contract.defaultOrigins) {
          const allowedPreflight = await fetch(`${proxy.origin}${path}`, {
            method: 'OPTIONS',
            headers: {
              Origin: origin,
              'Access-Control-Request-Method': 'POST',
            },
          })
          expect(allowedPreflight.status).toBe(204)
          expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(origin)
          expect(allowedPreflight.headers.get('access-control-allow-credentials')).toBeNull()

          const beforeAllowed = fake.receipts.length
          const allowed = await fetch(`${proxy.origin}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: '{}',
          })
          expect(allowed.status).toBe(201)
          expect(allowed.headers.get('access-control-allow-origin')).toBe(origin)
          expect(allowed.headers.get('access-control-allow-origin')).not.toBe('*')
          expect(allowed.headers.get('access-control-allow-credentials')).toBeNull()
          expect(fake.receipts).toHaveLength(beforeAllowed + 1)
        }

        const beforeRejected = fake.receipts.length
        for (const method of ['OPTIONS', 'POST'] as const) {
          const rejected = await fetch(`${proxy.origin}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          })
          expect(rejected.status).toBe(403)
          expect(rejected.headers.get('content-type')).toMatch(/^application\/json/u)
          expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
          expect(rejected.headers.get('access-control-allow-credentials')).toBeNull()
          expect(await rejected.text()).toBe('{"error":"origin not allowed"}')
        }
        expect(fake.receipts).toHaveLength(beforeRejected)
      }
    })

    it('returns completed 413 responses for declared and chunked overflow on every route', async () => {
      const fake = await startFakeUpstream(servers)
      const proxy = await startProxyApp(contract, fake.origin, servers, 8)
      const paths = ['/client-traces', '/client-metrics', '/client-replay/session?seq=0']

      for (const path of paths) {
        const before = fake.receipts.length
        const declared = await fetch(`${proxy.origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '123456789',
          signal: AbortSignal.timeout(2_000),
        })
        await expectErrorResponse(declared, 413, 'request body too large')

        const chunked = await rawPost(proxy.port, path, ['12345', '6789'])
        expect(chunked.status).toBe(413)
        expect(chunked.headers['content-type']).toMatch(/^application\/json/u)
        expect(chunked.body).toBe('{"error":"request body too large"}')
        expect(fake.receipts).toHaveLength(before)
        await expectHealthy(proxy.origin)
      }
    })

    it('contains rejected upstream fetches as completed 502 responses on every route', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const unavailableOrigin = await reserveUnavailableOrigin()
      const proxy = await startProxyApp(contract, unavailableOrigin, servers)
      const paths = ['/client-traces', '/client-metrics', '/client-replay/session?seq=0']

      for (const path of paths) {
        const response = await fetch(`${proxy.origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(2_000),
        })
        await expectErrorResponse(response, 502, 'upstream request failed')
        await expectHealthy(proxy.origin)
      }
    })

    it('preserves completed upstream non-success responses without unsafe headers', async () => {
      const fake = await startFakeUpstream(servers, {
        body: '{"error":"retry later"}',
        status: 429,
      })
      const proxy = await startProxyApp(contract, fake.origin, servers)
      const paths = ['/client-traces', '/client-metrics', '/client-replay/session?seq=0']

      for (const path of paths) {
        const response = await fetch(`${proxy.origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        expect(response.status).toBe(429)
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(await response.text()).toBe('{"error":"retry later"}')
      }
    })

    it('serves the example-specific API success routes', async () => {
      const fake = await startFakeUpstream(servers)
      const proxy = await startProxyApp(contract, fake.origin, servers)
      await contract.verifyExampleApi(proxy.origin)
    })
  })
}

async function startProxyApp(
  contract: ProxyContract,
  upstreamOrigin: string,
  servers: Set<Server>,
  bodyLimitBytes = 1024
): Promise<{ origin: string; port: number }> {
  const config = {
    ...contract.loadProxyConfig({
      LOGFIRE_ALLOWED_ORIGINS: contract.defaultOrigins.join(','),
      LOGFIRE_METRICS_URL: `${upstreamOrigin}/v1/metrics`,
      LOGFIRE_REPLAY_URL: `${upstreamOrigin}/v1/replay`,
      LOGFIRE_TOKEN: 'sentinel-token',
      LOGFIRE_URL: `${upstreamOrigin}/v1/traces`,
    }),
    bodyLimitBytes,
    port: 0,
  }
  const server = createServer(contract.createProxyApp(config))
  servers.add(server)
  await listen(server)
  const address = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${String(address.port)}`, port: address.port }
}

async function startFakeUpstream(
  servers: Set<Server>,
  responseConfig: { body: string; status: number } = { body: '{"accepted":true}', status: 201 }
): Promise<{ origin: string; receipts: Receipt[] }> {
  const receipts: Receipt[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      receipts.push({
        body: Buffer.concat(chunks),
        headers: request.headers,
        method: request.method ?? '',
        url: request.url ?? '',
      })
      response.statusCode = responseConfig.status
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Set-Cookie', 'upstream=secret')
      response.end(responseConfig.body)
    })
  })
  servers.add(server)
  await listen(server)
  const address = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${String(address.port)}`, receipts }
}

async function reserveUnavailableOrigin(): Promise<string> {
  const server = createServer()
  await listen(server)
  const address = server.address() as AddressInfo
  await closeServer(server)
  return `http://127.0.0.1:${String(address.port)}`
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })
}

async function rawPost(port: number, path: string, chunks: readonly string[]): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
        host: '127.0.0.1',
        method: 'POST',
        path,
        port,
      },
      (response) => {
        const responseChunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk)
        })
        response.on('end', () => {
          resolve({
            body: Buffer.concat(responseChunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          })
        })
      }
    )
    request.setTimeout(2_000, () => {
      request.destroy(new Error('chunked request timed out'))
    })
    request.on('error', reject)
    for (const chunk of chunks) {
      request.write(chunk)
    }
    request.end()
  })
}

async function expectErrorResponse(response: Response, status: number, message: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toMatch(/^application\/json/u)
  expect(await response.text()).toBe(JSON.stringify({ error: message }))
}

async function expectHealthy(origin: string): Promise<void> {
  const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
}
