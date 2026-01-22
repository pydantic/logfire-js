import 'dotenv/config'
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'example-node-script',
  serviceVersion: '1.0.0',
  environment: 'staging',
  diagLogLevel: logfire.DiagLogLevel.NONE,
  console: false,
})

logfire.span(
  'Hello from Node.js, {next_player}',
  {
    'attribute-key': 'attribute-value',
    next_player: '0',
    arr: [1, 2, 3],
    something: {
      value: [1, 2, 3],
      key: 'value',
    },
  },
  {
    tags: ['example', 'example2'],
  },
  (span) => {
    console.log('Inside span callback')
  }
)

await logfire.span('parent span', {}, {}, async (_span) => {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  logfire.info('nested span')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  logfire.debug('another nested span')
})

logfire.span('parent sync span', {}, {}, (_span) => {
  logfire.info('nested span')
})

logfire.span('parent sync span overload', {
  callback: (_span) => {
    logfire.info('nested span')
  },
})

const mySpan = logfire.startSpan('a manual parent span', { foo: 'foo' })

logfire.info('manual child span', {}, { parentSpan: mySpan })

logfire.reportError('Something went wrong in manual span', new Error('Manual error'), { attrs: 'extra' })

mySpan.end()

if (process.env.TRIGGER_ERROR) {
  try {
    throw new Error('This is an error for testing purposes')
  } catch (error) {
    logfire.reportError('An error occurred', error as Error)
    console.error('An error occurred:', error)
  }
}
