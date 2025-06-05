import 'dotenv/config'
import * as logfire from 'logfire'

logfire.configure({
  serviceName: 'example-node-script',
  serviceVersion: '1.0.0',
  environment: 'staging',
  token: 'pylf_v1_eu_fcksvB6FNdWKZ3xGbrG8g8GXHFqPfFXgtRgnZdvV6PCj',
  diagLogLevel: logfire.DiagLogLevel.DEBUG,
  codeSource: {
    repository: 'https://github.com/pydantic/pydantic',
    revision: 'master',
  },
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
