import 'dotenv/config'
import * as logfire from '@pydantic/logfire-node'
import { AgentControl, applyInstructions, applySettings, applyToolDefinitions, buildBaseline } from '@pydantic/logfire-node/agent-control'
import type { InstructionBlock, ToolDef } from '@pydantic/logfire-node/agent-control'
import type { VariablesConfig } from '@pydantic/logfire-node/vars'
import { getVariableProvider } from '@pydantic/logfire-node/vars'

// What someone would have saved in the Logfire UI for an agent named `Checkout Assistant`. The
// variable name is the agent's name normalized: lowercased, with everything outside `[a-z0-9_]`
// turned into `_`, which is the rule the UI and every Agent Control SDK share.
const publishedConfig = {
  instructions: [
    // No `id`, so this adds a block rather than replacing one.
    'Escalate anything over $500 to a human.',
    // An `id` the baseline lists, so this rewrites that block in place.
    { id: 'agent:refunds', instructions: 'Confirm the order total before issuing a refund.' },
  ],
  model: 'anthropic:claude-fable-5-1',
  settings: { max_tokens: 2048, temperature: 0.4 },
  tool_definitions: [
    {
      description: 'Look up the current weather for a city.',
      name: 'get_weather',
      new_name: 'lookup_weather',
      parameters: { city: { description: "City name, e.g. 'London'" } },
    },
  ],
}

const localVariablesConfig = {
  variables: {
    agent__checkout_assistant: {
      labels: {
        production: { serialized_value: JSON.stringify(publishedConfig), version: 1 },
      },
      name: 'agent__checkout_assistant',
      overrides: [],
      rollout: { labels: { production: 1 } },
    },
  },
} satisfies VariablesConfig

logfire.configure({
  console: false,
  diagLogLevel: logfire.DiagLogLevel.NONE,
  environment: 'local',
  sendToLogfire: false,
  serviceName: 'example-node-agent-control',
  serviceVersion: '1.0.0',
  variables: { config: localVariablesConfig, instrument: false },
})

// The agent as written. `dynamic` marks a block the agent recomputes per request: it cannot be
// addressed by a managed value, because replacing it would pin one rendering forever and dropping
// it would remove the computation, and its text is never published to the shared baseline.
const codeBlocks: InstructionBlock[] = [
  { dynamic: false, id: 'agent', text: 'You are a concise checkout assistant.' },
  { dynamic: false, id: 'agent:refunds', text: 'Always confirm the order total.' },
  { dynamic: true, id: 'agent:today', text: `Today is ${new Date().toDateString()}.` },
]

const codeTools: ToolDef[] = [
  {
    description: 'Get the current weather for a city.',
    name: 'get_weather',
    parametersJsonSchema: {
      properties: { city: { description: 'City to look up.', type: 'string' } },
      required: ['city'],
      type: 'object',
    },
    toolset: '<agent>',
  },
]

const codeModel = 'openai:gpt-5.6-sol'
const codeSettings = { extra_headers: { 'x-tenant': 'acme' }, temperature: 0.1 }

const control = new AgentControl('Checkout Assistant', { label: 'production' })
console.log('display name:', control.name, '-> variable:', control.variableName)

// Once per process: describe the agent for the Logfire editor to layer a value onto. It writes in
// the background, at most once per variable, and never throws.
control.publishBaseline(buildBaseline({ instructions: codeBlocks, model: codeModel, settings: codeSettings, tools: codeTools }))

// Once per run: resolve, then do the whole run inside the resolution's telemetry context, so every
// span carries the label the run was actually driven by.
await control.run(async ({ config, label, reason, version }) => {
  console.log('resolved:', { label, reason, version })
  if (config === null) {
    console.log('nothing published; running on the code-defined agent')
    return
  }

  const options = { onUnmatched: control.onUnmatched }
  const { blocks, unapplied: unappliedInstructions } = applyInstructions(codeBlocks, config, options)
  const { tools, routes, unapplied: unappliedTools } = applyToolDefinitions(codeTools, config, options)
  const settings = { ...codeSettings, ...applySettings(config, options) }

  console.log('instructions sent to the model:')
  for (const block of blocks) {
    console.log(`  [${block.id ?? '<added>'}${block.dynamic ? ', dynamic' : ''}] ${block.text}`)
  }
  console.log(
    'tools advertised:',
    tools.map((tool) => tool.name)
  )
  // Routing is handed over rather than applied, because frameworks differ on whether the
  // implementation should see its old name or its new one.
  console.log('a call to `lookup_weather` runs:', routes['lookup_weather'])
  console.log('model:', config.model ?? codeModel)
  console.log('settings:', settings)
  console.log('published entries that reached nothing:', [...unappliedInstructions, ...unappliedTools].length)

  await logfire.span('checkout assistant run', {}, {}, async () => {
    logfire.info('this span carries the resolved label on baggage')
  })
})

const stored = await getVariableProvider().getVariableConfig?.('agent__checkout_assistant')
console.log('baseline published as the variable example:\n', stored?.example)

await logfire.shutdown()
