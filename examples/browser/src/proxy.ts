import express from 'express'
import cors from 'cors'

const app = express()
const PORT = 8989

// Enable CORS - handle origins dynamically to avoid wildcard issues with credentials
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  })
)

const logfireUrl = process.env.LOGFIRE_URL || 'http://localhost:4318/v1/traces'
const logfireMetricsUrl = process.env.LOGFIRE_METRICS_URL || logfireUrl.replace(/\/v1\/traces$/, '/v1/metrics')
const logfireReplayUrl = process.env.LOGFIRE_REPLAY_URL || logfireUrl.replace(/\/v1\/traces$/, '/v1/replay')
const token = process.env.LOGFIRE_TOKEN || ''

app.post('/client-replay/:sessionId', express.raw({ limit: '10mb', type: '*/*' }), async (req, res) => {
  const replayUrl = `${logfireReplayUrl.replace(/\/+$/u, '')}/${encodeURIComponent(req.params['sessionId'] ?? '')}?seq=${String(req.query['seq'] ?? '')}`
  const replayBody = new Uint8Array(req.body as Buffer)
  const response = await fetch(replayUrl, {
    method: 'POST',
    headers: {
      'Content-Encoding': String(req.header('content-encoding') ?? 'gzip'),
      'Content-Type': String(req.header('content-type') ?? 'application/json'),
      Authorization: token,
    },
    body: replayBody,
  })
  res.status(response.status).send(await response.text())
})

// Parse JSON bodies after the raw replay route.
app.use(express.json())

async function proxyTelemetry(req: express.Request, res: express.Response, url: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify(req.body),
  })
  res.status(response.status).send(await response.text())
}

app.post('/client-traces', async (req, res) => {
  await proxyTelemetry(req, res, logfireUrl)
})

app.post('/client-metrics', async (req, res) => {
  await proxyTelemetry(req, res, logfireMetricsUrl)
})

// Start the server
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}, proxying traces to ${logfireUrl}, metrics to ${logfireMetricsUrl}, and replay to ${logfireReplayUrl}`
  )
})

export default app
