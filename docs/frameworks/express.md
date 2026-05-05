---
title: Express
description: Instrument an Express application with @pydantic/logfire-node.
---

# Express

Express applications should configure Logfire before Express is imported, so OpenTelemetry can patch the framework and HTTP modules.

## Install

```bash
npm install express @pydantic/logfire-node dotenv
```

## Instrumentation File

```ts title="instrumentation.ts"
import * as logfire from '@pydantic/logfire-node'
import 'dotenv/config'

logfire.configure({
  serviceName: 'express-api',
})
```

Put your token in `.env`:

```bash title=".env"
LOGFIRE_TOKEN=your-write-token
```

## App Code

```ts title="app.ts"
import express from 'express'
import * as logfire from '@pydantic/logfire-node'

const app = express()

app.get('/rolldice', (_req, res) => {
  logfire.info('rolling dice')
  res.send(String(Math.floor(Math.random() * 6) + 1))
})

app.use((err: Error, _req: express.Request, res: express.Response, _next: () => unknown) => {
  logfire.reportError('express request failed', err)
  res.status(500).send('internal server error')
})

app.listen(8080)
```

Run with the instrumentation file loaded first:

```bash
node --import ./instrumentation.js app.js
```

For a complete project, see `examples/express`.
