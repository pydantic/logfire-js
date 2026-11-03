import 'dotenv/config'
import { openai } from '@ai-sdk/openai'
import { OpenTelemetry } from '@ai-sdk/otel'
import * as logfire from '@pydantic/logfire-node'
import { registerTelemetry } from 'ai'

import { analyzeExpenses } from './agent.ts'

logfire.configure({
  serviceName: 'example-agent-sandboxes-ai-sdk',
  diagLogLevel: logfire.DiagLogLevel.NONE,
  console: false,
})
registerTelemetry(new OpenTelemetry())

console.log(await analyzeExpenses(openai('gpt-6-luna')))

await logfire.shutdown()
