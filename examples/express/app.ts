import type { Express, Request, Response } from 'express'
import express from 'express'
import * as logfire from '@pydantic/logfire-node'

const PORT: number = parseInt(process.env.EXPRESS_PORT || '8080')
const app: Express = express()

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

// Report an error to Logfire, using the Express error handler.
app.use((err: Error, _req: Request, res: Response, _next: () => unknown) => {
  logfire.reportError(err.message, err)
  res.status(500)
  res.send('An error occured')
})

app.listen(PORT, () => {
  console.log(`Listening for requests on http://localhost:${PORT}/rolldice`)
})
