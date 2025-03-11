import 'dotenv/config'
import * as logfire from 'logfire'

logfire.configure({
  serviceName: 'example-node-script',
  serviceVersion: '1.0.0',
  environment: 'staging',
  diagLogLevel: logfire.DiagLogLevel.INFO,
  codeSource: {
    repository: 'https://github.com/pydantic/pydantic',
    revision: 'master',
  },
})


logfire.info('Hello from Node.js', {
  'attribute-key': 'attribute-value'
}, {
  tags: ['example', 'example2']
})
