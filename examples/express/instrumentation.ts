import * as logfire from '@pydantic/logfire-node'
import 'dotenv/config'

logfire.configure({
  diagLogLevel: logfire.DiagLogLevel.ERROR,
})
