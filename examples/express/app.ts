import type { Express, Request, Response } from 'express'
import express from 'express'
import * as logfire from '@pydantic/logfire-node'

const PORT: number = parseInt(process.env.EXPRESS_PORT || '8080')
const app: Express = express()

function createStructuredCauseDemoError(): Error {
  const databaseCause = Object.assign(new Error('database connection rejected'), {
    attempt: 3,
    details: {
      host: 'primary-db.internal',
      pool: 'checkout-writes',
      retryable: true,
    },
    statusCode: 503,
  })

  const serviceCause = Object.assign(new Error('checkout storage call failed', { cause: databaseCause }), {
    operation: 'checkout.create_order',
    requestId: 'demo-request-structured-cause',
  })

  return Object.assign(new Error('structured Error.cause demo failed', { cause: serviceCause }), {
    cartId: 'cart_demo_123',
    customerTier: 'enterprise',
  })
}

function getRandomNumber(min: number, max: number) {
  return Math.floor(Math.random() * (max - min) + min)
}

app.get('/rolldice', (req, res) => {
  // read the query parameter error
  const error = req.query.error
  if (error) {
    throw new Error('An error occurred')
  }

  logfire.span('parent-span', {}, {}, async (parentSpan) => {
    logfire.info('child span')
    parentSpan.end()
  })

  res.send(getRandomNumber(1, 6).toString())
})

app.get('/structured-cause-error', (_req, _res) => {
  throw createStructuredCauseDemoError()
})

// Report an error to Logfire, using the Express error handler.
app.use((err: Error, _req: Request, res: Response, _next: () => unknown) => {
  logfire.reportError(err.message, err, {
    demo: 'structured-error-cause',
    expectedAttributes: ['exception.cause', 'logfire.json_schema'],
  })
  res.status(500)
  res.send('An error occurred')

app.listen(PORT, () => {
  console.log(`Listening for requests on http://localhost:${PORT}/rolldice`)
  console.log(`Structured cause demo: http://localhost:${PORT}/structured-cause-error`)
})
