import type { Server } from 'node:http'

import express from 'express'

const DEFAULT_TRACE_URL = 'https://logfire-api.pydantic.dev/v1/traces'
const DEFAULT_METRICS_URL = 'https://logfire-api.pydantic.dev/v1/metrics'
const DEFAULT_REPLAY_URL = 'https://logfire-api.pydantic.dev/v1/replay'
const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024
const MAX_ALLOWED_ORIGINS = 16

export interface DevelopmentProxyConfig {
  allowedOrigins: readonly string[]
  bodyLimitBytes: number
  host: string
  logfireMetricsUrl: string
  logfireReplayUrl: string
  logfireUrl: string
  port: number
  token: string
}

interface LoadProxyConfigOptions {
  defaultAllowedOrigins: readonly string[]
  defaultPort: number
  env?: NodeJS.ProcessEnv
}

export class RequestBodyTooLargeError extends Error {}

export function loadDevelopmentProxyConfig({
  defaultAllowedOrigins,
  defaultPort,
  env = process.env,
}: LoadProxyConfigOptions): DevelopmentProxyConfig {
  const logfireUrl = validateUpstreamUrl(env.LOGFIRE_URL ?? DEFAULT_TRACE_URL, 'LOGFIRE_URL')
  const logfireMetricsUrl = validateUpstreamUrl(
    env.LOGFIRE_METRICS_URL ??
      (env.LOGFIRE_URL === undefined ? DEFAULT_METRICS_URL : replaceEndpoint(logfireUrl, 'metrics', 'LOGFIRE_METRICS_URL')),
    'LOGFIRE_METRICS_URL'
  )
  const logfireReplayUrl = validateUpstreamUrl(
    env.LOGFIRE_REPLAY_URL ??
      (env.LOGFIRE_URL === undefined ? DEFAULT_REPLAY_URL : replaceEndpoint(logfireUrl, 'replay', 'LOGFIRE_REPLAY_URL')),
    'LOGFIRE_REPLAY_URL'
  )
  const token = env.LOGFIRE_TOKEN?.trim() ?? ''
  if (token.length === 0) {
    throw new Error('LOGFIRE_TOKEN is required by the development proxy')
  }

  return {
    allowedOrigins: parseAllowedOrigins(env.LOGFIRE_ALLOWED_ORIGINS, defaultAllowedOrigins),
    bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
    host: validateHost(env.HOST ?? '127.0.0.1'),
    logfireMetricsUrl,
    logfireReplayUrl,
    logfireUrl,
    port: parsePort(env.PORT, defaultPort),
    token,
  }
}

export function createDevelopmentProxyApp(config: DevelopmentProxyConfig): express.Express {
  const app = express()

  app.use((request, response, next) => {
    const origin = request.header('origin')
    if (origin !== undefined) {
      if (!config.allowedOrigins.includes(origin)) {
        sendError(response, 403, 'origin not allowed')
        return
      }
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
    }

    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Encoding, X-CSRF, X-Logfire-Example')
      response.status(204).end()
      return
    }
    next()
  })

  app.post('/client-traces', (request, response) => {
    void forwardRequest(request, response, config, config.logfireUrl)
  })

  app.post('/client-metrics', (request, response) => {
    void forwardRequest(request, response, config, config.logfireMetricsUrl)
  })

  app.post('/client-replay/:sessionId', (request, response) => {
    const replayUrl = new URL(config.logfireReplayUrl)
    const sessionId = request.params['sessionId'] ?? ''
    const clientUrl = new URL(request.originalUrl, 'http://127.0.0.1')
    const seq = clientUrl.searchParams.get('seq') ?? ''
    replayUrl.pathname = `${replayUrl.pathname.replace(/\/+$/u, '')}/${encodeURIComponent(sessionId)}`
    replayUrl.search = ''
    replayUrl.searchParams.set('seq', seq)
    void forwardRequest(request, response, config, replayUrl.toString())
  })

  app.use(express.json())

  app.get('/health', (_request, response) => {
    response.json({ ok: true })
  })

  return app
}

export async function listenDevelopmentProxy(app: express.Express, config: DevelopmentProxyConfig): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host)
    server.once('error', reject)
    server.once('listening', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

async function forwardRequest(
  request: express.Request,
  response: express.Response,
  config: DevelopmentProxyConfig,
  upstreamUrl: string
): Promise<void> {
  try {
    const body = await readRawBody(request, config.bodyLimitBytes)
    const contentType = request.header('content-type')
    const contentEncoding = request.header('content-encoding')
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: normalizeAuthorization(config.token),
        ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
        ...(contentEncoding === undefined ? {} : { 'Content-Encoding': contentEncoding }),
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    })
    const responseContentType = upstreamResponse.headers.get('content-type')
    if (responseContentType !== null) {
      response.setHeader('Content-Type', responseContentType)
    }
    response.status(upstreamResponse.status).send(Buffer.from(await upstreamResponse.arrayBuffer()))
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendError(response, 413, 'request body too large')
      return
    }
    console.error('Development proxy upstream request failed')
    sendError(response, 502, 'upstream request failed')
  }
}

function readRawBody(request: express.Request, limitBytes: number): Promise<Buffer> {
  const contentLength = request.header('content-length')
  if (contentLength !== undefined) {
    const declaredLength = Number.parseInt(contentLength, 10)
    if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
      request.resume()
      return Promise.reject(new RequestBodyTooLargeError('request body too large'))
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    request.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      totalBytes += chunk.byteLength
      if (totalBytes > limitBytes) {
        chunks.length = 0
        fail(new RequestBodyTooLargeError('request body too large'))
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    request.on('aborted', () => {
      fail(new Error('request aborted'))
    })
    request.on('error', fail)
  })
}

function parseAllowedOrigins(value: string | undefined, defaultOrigins: readonly string[]): readonly string[] {
  const rawOrigins = value === undefined ? [...defaultOrigins] : value.split(',').map((origin) => origin.trim())
  if (rawOrigins.length === 0 || rawOrigins.length > MAX_ALLOWED_ORIGINS || rawOrigins.some((origin) => origin.length === 0)) {
    throw new Error(`LOGFIRE_ALLOWED_ORIGINS must contain 1-${String(MAX_ALLOWED_ORIGINS)} non-empty origins`)
  }

  const origins = rawOrigins.map((origin) => {
    if (origin === '*' || /[*?[\]]/u.test(origin)) {
      throw new Error('LOGFIRE_ALLOWED_ORIGINS does not accept wildcards or patterns')
    }
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Error(`invalid LOGFIRE_ALLOWED_ORIGINS origin: ${origin}`)
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      origin !== url.origin
    ) {
      throw new Error(`LOGFIRE_ALLOWED_ORIGINS requires canonical http(s) origins: ${origin}`)
    }
    return url.origin
  })

  if (new Set(origins).size !== origins.length) {
    throw new Error('LOGFIRE_ALLOWED_ORIGINS must not contain duplicates')
  }
  return origins
}

function validateUpstreamUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${name} must be an absolute http(s) URL without credentials, a query, or a fragment`)
  }
  return url.toString()
}

function replaceEndpoint(logfireUrl: string, endpoint: 'metrics' | 'replay', requiredName: string): string {
  if (!/\/v1\/traces$/u.test(logfireUrl)) {
    throw new Error(`${requiredName} is required when LOGFIRE_URL does not end in /v1/traces`)
  }
  return logfireUrl.replace(/\/v1\/traces$/u, `/v1/${endpoint}`)
}

function validateHost(host: string): string {
  const value = host.trim()
  if (value !== '127.0.0.1') {
    throw new Error('HOST must be 127.0.0.1 for the development proxy')
  }
  return value
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer from 0 through 65535')
  }
  return port
}

function normalizeAuthorization(token: string): string {
  return /^Bearer\s+/iu.test(token) ? token : `Bearer ${token}`
}

function sendError(response: express.Response, status: number, message: string): void {
  response
    .status(status)
    .type('application/json')
    .send(JSON.stringify({ error: message }))
}
