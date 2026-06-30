import cors from 'cors'
import express from 'express'

const app = express()
const port = Number.parseInt(process.env.PORT ?? '8990', 10)

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  })
)

const logfireUrl = process.env.LOGFIRE_URL || 'http://localhost:3000/v1/traces'
const logfireMetricsUrl = process.env.LOGFIRE_METRICS_URL || logfireUrl.replace(/\/v1\/traces$/u, '/v1/metrics')
const logfireReplayUrl = process.env.LOGFIRE_REPLAY_URL || logfireUrl.replace(/\/v1\/traces$/u, '/v1/replay')
const token = process.env.LOGFIRE_TOKEN || ''
const replayBodyLimitBytes = 10 * 1024 * 1024

class RequestBodyTooLargeError extends Error {}

function authHeaders(): Record<string, string> {
  if (token.length === 0) {
    return {}
  }
  return { Authorization: /^Bearer\s+/iu.test(token) ? token : `Bearer ${token}` }
}

function readRawBody(req: express.Request, limitBytes: number): Promise<ArrayBuffer> {
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

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength
      if (totalBytes > limitBytes) {
        fail(new RequestBodyTooLargeError('Replay request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) {
        return
      }
      settled = true
      const body = Buffer.concat(chunks)
      resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
    })
    req.on('error', fail)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

app.post('/client-replay/:sessionId', async (req, res) => {
  const sessionId = req.params['sessionId'] ?? ''
  const seq = String(req.query['seq'] ?? '')
  const replayUrl = `${logfireReplayUrl.replace(/\/+$/u, '')}/${encodeURIComponent(sessionId)}?seq=${seq}`
  try {
    const body = await readRawBody(req, replayBodyLimitBytes)
    const contentEncoding = req.header('content-encoding')
    const response = await fetch(replayUrl, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        ...(contentEncoding === undefined ? {} : { 'Content-Encoding': contentEncoding }),
        'Content-Type': String(req.header('content-type') ?? 'application/json'),
      },
      body,
    })
    res.status(response.status).send(await response.text())
  } catch (error) {
    console.error('Replay proxy request failed', error)
    res.status(error instanceof RequestBodyTooLargeError ? 413 : 502).json({ error: 'replay proxy request failed' })
  }
})

app.use(express.json())

async function proxyTelemetry(req: express.Request, res: express.Response, url: string): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    })
    res.status(response.status).send(await response.text())
  } catch (error) {
    console.error('Telemetry proxy request failed', error)
    res.status(502).json({ error: 'telemetry proxy request failed' })
  }
}

app.post('/client-traces', async (req, res) => {
  await proxyTelemetry(req, res, logfireUrl)
})

app.post('/client-metrics', async (req, res) => {
  await proxyTelemetry(req, res, logfireMetricsUrl)
})

app.get('/api/catalog', async (req, res) => {
  await sleep(180)
  res.json({
    region: req.query['region'] ?? 'unknown',
    products: [
      { sku: 'LF-101', name: 'Replay capture', stock: 12 },
      { sku: 'LF-204', name: 'Browser traces', stock: 7 },
      { sku: 'LF-330', name: 'Vitals metrics', stock: 18 },
    ],
  })
})

app.get('/api/inventory', async (_req, res) => {
  await sleep(120)
  res.json({
    warehouse: 'north-1',
    available: Math.floor(40 + Math.random() * 20),
    checkedAt: new Date().toISOString(),
  })
})

app.post('/api/checkout', async (req, res) => {
  await sleep(240)
  res.status(202).json({
    accepted: true,
    orderId: `ord_${Date.now().toString(36)}`,
    userId: req.body?.userId ?? 'anonymous',
  })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.listen(port, () => {
  console.log(
    `RUM replay proxy running on port ${String(port)}; traces -> ${logfireUrl}; metrics -> ${logfireMetricsUrl}; replay -> ${logfireReplayUrl}`
  )
})

export default app
