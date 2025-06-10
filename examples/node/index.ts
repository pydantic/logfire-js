import 'dotenv/config'
import * as logfire from 'logfire'

logfire.configure({
  serviceName: 'example-node-script',
  serviceVersion: '1.0.0',
  environment: 'staging',
  diagLogLevel: logfire.DiagLogLevel.DEBUG,
})


logfire.span('Hello from Node.js, {next_player}', {
  'attribute-key': 'attribute-value',
  next_player: '0',
  arr: [1, 2, 3],
  something: {
    value: [1, 2, 3],
    key: 'value'
  }
}, {
  tags: ['example', 'example2']
}, (span) => {
  span.end()
})

if (process.env.TRIGGER_ERROR) {
  try {
    throw new Error('This is an error for testing purposes');
  } catch (error) {
    logfire.reportError("An error occurred", error as Error);
    console.error("An error occurred:", error);
  }
}
