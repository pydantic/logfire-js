// Runs the agent with a mock model that replays the Python from Monty's expense_analysis example, split
// across run_code calls that share one sandbox session, against a
// local stand-in for the Agent Sandboxes server, so CI needs neither an OpenAI key nor a Logfire API key.
// The relay is the same as in examples/agent-sandboxes/smoke.ts: each WebSocket connection goes to a local
// `monty subprocess` worker, which speaks protobuf frames with a little-endian 4-byte length prefix.
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import type { IncomingHttpHeaders } from 'node:http'

import { OpenTelemetry } from '@ai-sdk/otel'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfire from '@pydantic/logfire-node'
import { findMontyBinary } from '@pydantic/monty/node'
import { registerTelemetry } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

import { analyzeExpenses } from './agent.ts'

const API_KEY = 'smoke-test-key'

const SETUP = `team_data = await get_team_members(department="Engineering")
STANDARD_BUDGET = 5000

async def travel_total(user_id: int) -> int:
    expenses_data = await get_expenses(user_id=user_id, quarter="Q3", category="travel")
    return sum(item["amount"] for item in expenses_data["expenses"])

len(team_data["members"])`

const ANALYSIS = `over_budget_list = []
for member in team_data["members"]:
    total_spent = await travel_total(member["id"])
    if total_spent > STANDARD_BUDGET:
        custom = await get_custom_budget(user_id=member["id"])
        budget = custom["budget"] if custom is not None else STANDARD_BUDGET
        if total_spent > budget:
            over_budget_list.append({"name": member["name"], "total_spent": total_spent, "budget": budget})
over_budget_list`

const CAROL = 'await travel_total(3)'

const ANSWER = 'Carol Jones went over her Q3 travel budget.'

const upgrades: { headers: IncomingHttpHeaders; url: string | undefined }[] = []
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })

server.on('connection', (ws, req) => {
  upgrades.push({ headers: req.headers, url: req.url })
  const worker = spawn(findMontyBinary(), ['subprocess'], { stdio: ['pipe', 'pipe', 'inherit'] })

  ws.on('message', (data: Buffer) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(data.length)
    worker.stdin.write(Buffer.concat([prefix, data]))
  })

  let pending = Buffer.alloc(0)
  worker.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = pending.readUInt32LE(0)
      ws.send(pending.subarray(4, 4 + size))
      pending = pending.subarray(4 + size)
    }
  })

  ws.on('close', () => worker.kill())
  worker.on('exit', () => ws.close())
})

await once(server, 'listening')
const address = server.address()
assert(address !== null && typeof address === 'object')

process.env['LOGFIRE_API_KEY'] = API_KEY
process.env['LOGFIRE_BASE_URL'] = `http://127.0.0.1:${String(address.port)}`

const spans = new InMemorySpanExporter()
logfire.configure({
  serviceName: 'example-agent-sandboxes-ai-sdk-smoke',
  diagLogLevel: logfire.DiagLogLevel.NONE,
  console: false,
  sendToLogfire: false,
  additionalSpanProcessors: [new SimpleSpanProcessor(spans)],
})
registerTelemetry(new OpenTelemetry())

function step(content: LanguageModelV4GenerateResult['content'], finish: 'stop' | 'tool-calls'): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  }
}

function runCodeCall(toolCallId: string, code: string): LanguageModelV4GenerateResult['content'][number] {
  return { type: 'tool-call', toolCallId, toolName: 'run_code', input: JSON.stringify({ code }) }
}

const model = new MockLanguageModelV4({
  doGenerate: [
    step([runCodeCall('setup', SETUP)], 'tool-calls'),
    // Two calls in one step run in parallel, so they also check that run_code queues feeds on the shared session.
    step([runCodeCall('analysis', ANALYSIS), runCodeCall('carol', CAROL)], 'tool-calls'),
    step([{ type: 'text', text: ANSWER }], 'stop'),
  ],
})

assert.equal(await analyzeExpenses(model), ANSWER)
server.close()
// The exporter drops its spans on shutdown.
const finished = spans.getFinishedSpans()
await logfire.shutdown()

// The expense tools reach the model only as Python functions in the run_code description.
const [firstCall, , lastCall] = model.doGenerateCalls
assert(firstCall !== undefined && lastCall !== undefined)
assert.deepEqual(
  firstCall.tools?.map((t) => t.name),
  ['run_code']
)
const runCodeTool = firstCall.tools?.[0]
assert(runCodeTool?.type === 'function')
assert.match(runCodeTool.description ?? '', /async def get_expenses\(\*, user_id: int, quarter: str, category: str\) -> Any:/)

// The later calls use team_data and travel_total from the first one.
const toolResults = Object.fromEntries(
  lastCall.prompt
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .flatMap((part) => (part.type === 'tool-result' ? [[part.toolCallId, part.output]] : []))
)
assert.deepEqual(toolResults, {
  setup: { type: 'json', value: 5 },
  analysis: { type: 'json', value: [{ name: 'Carol Jones', total_spent: 6740, budget: 5000 }] },
  carol: { type: 'json', value: 6740 },
})

assert.equal(upgrades.length, 1)
const [upgrade] = upgrades
assert(upgrade !== undefined)
assert.equal(upgrade.url, '/monty-ws/')
assert.equal(upgrade.headers.authorization, `Bearer ${API_KEY}`)

// The one sandbox session joins the trace under the agent run's span, and the tool calls each run_code call
// makes are nested under that call's span.
const runSpan = finished.find((span) => span.name === 'analyze expenses')
assert(runSpan !== undefined, 'missing agent run span')
const { spanId, traceId } = runSpan.spanContext()
assert.equal(upgrade.headers['traceparent'], `00-${traceId}-${spanId}-01`)
const runCodeSpans = finished.filter((span) => span.name === 'execute_tool run_code')
assert.equal(runCodeSpans.length, 3)
const nestedToolNames = runCodeSpans.map((runCodeSpan) =>
  finished
    .filter((span) => span.name === 'run_code called {tool_name}' && span.parentSpanContext?.spanId === runCodeSpan.spanContext().spanId)
    .map((span) => span.attributes['tool_name'])
)
assert.deepEqual(nestedToolNames, [
  ['get_team_members'],
  ['get_expenses', 'get_expenses', 'get_custom_budget', 'get_expenses', 'get_custom_budget', 'get_expenses', 'get_expenses'],
  ['get_expenses'],
])

console.log('agent sandboxes AI SDK smoke test passed')
