import 'dotenv/config'
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import * as logfire from '@pydantic/logfire-node'
import { CollectString } from '@pydantic/monty'

// Sending spans needs LOGFIRE_TOKEN; without it, configure() still sets up trace context propagation,
// so the server-side sandbox spans carry this script's trace ID.
logfire.configure({
  serviceName: 'example-agent-sandboxes',
  diagLogLevel: logfire.DiagLogLevel.NONE,
  console: false,
})

await logfire.span('agent sandboxes demo', {}, {}, async () => {
  await using pool = await agentSandboxes()

  await using session = await pool.checkout()
  console.log('first snippet:', await session.feedRun('sum([20, 21, 1])'))

  await session.feedRun('total = 40')
  console.log('state across runs:', await session.feedRun('total + 2'))

  const output = new CollectString()
  const weather = await session.feedRun("print('Checking the weather')\nget_weather('London')", {
    externalLookup: { get_weather: (city: string) => `Sunny in ${city}` },
    printCallback: output,
  })
  console.log('host function:', weather, '|', output.output.trim())

  await session.feedRun('items = [1]')
  const base = await session.dump()
  const branch = async (value: string): Promise<unknown> => {
    await using fork = await pool.checkout()
    await fork.loadSession(base)
    await fork.feedRun(`items.append(${JSON.stringify(value)})`)
    return fork.feedRun('repr(items)')
  }
  console.log('forks:', await Promise.all([branch('a'), branch('b')]))
})

await logfire.shutdown()
