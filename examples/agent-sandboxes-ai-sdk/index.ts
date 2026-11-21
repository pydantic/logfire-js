import 'dotenv/config'
import { openai } from '@ai-sdk/openai'
import { OpenTelemetry } from '@ai-sdk/otel'
import * as logfire from '@pydantic/logfire-node'
import { registerTelemetry } from 'ai'

import { reviewTravel } from './agent.ts'
import { expectedReport } from './expenses.ts'

logfire.configure({
  serviceName: 'example-agent-sandboxes-ai-sdk',
  diagLogLevel: logfire.DiagLogLevel.NONE,
  console: false,
})
registerTelemetry(new OpenTelemetry())

console.log(await reviewTravel(openai('gpt-6-luna')))

// The data is generated from a fixed seed, so the correct answer is known. Compare it with the agent's.
const expected = expectedReport()
console.log('\nExpected department totals (USD):', expected.department_totals_usd)
console.log('Expected over budget:', expected.over_budget.map(({ name, over_by_usd }) => `${name} (+${String(over_by_usd)})`).join(', '))

await logfire.shutdown()
