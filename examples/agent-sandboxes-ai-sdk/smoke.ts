// Runs the agent with a mock model that replays a fixed travel review across four run_code calls in one sandbox
// session, against a local stand-in for the Agent Sandboxes server, so CI needs neither an OpenAI key nor a
// Logfire API key. It checks four things code mode must get right: state kept between calls, parallel calls,
// recovery from a failing tool, and returning a small summary of a large dataset.
// The relay is the same as in examples/agent-sandboxes/smoke.ts: each gRPC session stream goes to a local
// `monty subprocess` worker, which speaks protobuf frames with a little-endian 4-byte length prefix.
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import type { ServerDuplexStream } from '@grpc/grpc-js'
import type { ToolSet } from 'ai'

import { OpenTelemetry } from '@ai-sdk/otel'
import { Metadata, Server, ServerCredentials } from '@grpc/grpc-js'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfire from '@pydantic/logfire-node'
import { findMontyBinary } from '@pydantic/monty/node'
import { registerTelemetry } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Report } from './expenses.ts'

import { reviewTravel } from './agent.ts'
import { expectedReport, expenseTools } from './expenses.ts'

const API_KEY = 'smoke-test-key'
// `SpanStatusCode.ERROR` in @opentelemetry/api, which this example does not depend on.
const SPAN_STATUS_ERROR = 2

// Fetches everything at once and keeps it in the session for the later calls. Mixing ints and strings in one
// dict literal would make Monty's type checker infer \`int | str\` for the ID and reject the call, so the
// typed members are kept as they come back.
const SETUP = `import asyncio

departments = (await list_departments())["departments"]
teams = await asyncio.gather(*[get_team_members(department=name) for name in departments])
people = []
department_of = {}
for team in teams:
    for member in team["members"]:
        people.append(member)
        department_of[member["id"]] = team["department"]
expense_lists = await asyncio.gather(*[get_expenses(user_id=person["id"], quarter="Q3", category="travel") for person in people])
items = {}
for result in expense_lists:
    items[result["user_id"]] = result["expenses"]
currencies = sorted(set([item["currency"] for expenses in items.values() for item in expenses]))
{"people": len(people), "line_items": sum([len(expenses) for expenses in items.values()]), "currencies": currencies}`

// Fails: the rate service has no CHF rate. The model sees the tool's error message.
const RATES = `rates = {}
for currency in currencies:
    rates[currency] = (await get_exchange_rate(currency=currency))["usd_per_unit"]
rates`

// Valid Python that Monty's type checker rejects: it does not narrow \`custom_budgets[i]\` after the None check.
// With every snippet checked, real models spent all their steps on this; run_code checks only the first.
const BUDGETS = `custom_budgets = await asyncio.gather(*[get_custom_budget(user_id=person["id"]) for person in people])
budgets = {}
for i, person in enumerate(people):
    budgets[person["id"]] = custom_budgets[i]["budget"] if custom_budgets[i] is not None else 5000
len([budget for budget in budgets.values() if budget != 5000])`

// Recovers with the fixed rate the error message gave, and reuses everything the earlier calls defined.
const REPORT = `rates = {}
for currency in currencies:
    try:
        rates[currency] = (await get_exchange_rate(currency=currency))["usd_per_unit"]
    except Exception:
        rates[currency] = 1.13
department_totals = {}
over_budget = []
for person in people:
    spent = sum([item["amount"] * rates[item["currency"]] for item in items[person["id"]]])
    department = department_of[person["id"]]
    if department not in department_totals:
        department_totals[department] = 0
    department_totals[department] = department_totals[department] + spent
    budget = budgets[person["id"]]
    if spent > budget:
        over_budget.append({"name": person["name"], "department": department, "spent_usd": round(spent, 2), "budget_usd": budget, "over_by_usd": round(spent - budget, 2)})
over_budget.sort(key=lambda row: row["over_by_usd"], reverse=True)
{"department_totals_usd": {name: round(total, 2) for name, total in department_totals.items()}, "over_budget": over_budget, "line_items": sum([len(expenses) for expenses in items.values()])}`

const ANSWER = 'Eight employees went over their Q3 travel budget; Grace Kim in Support by the most.'

const SESSION_PATH = '/monty.v1.MontySession/Session'
const identity = (buffer: Buffer): Buffer => buffer

const streams: { metadata: Metadata; path: string }[] = []

function relay(stream: ServerDuplexStream<Buffer, Buffer>): void {
  streams.push({ metadata: stream.metadata, path: stream.getPath() })
  // The client sends nothing until the server admits the stream with its response headers.
  stream.sendMetadata(new Metadata())
  const worker = spawn(findMontyBinary(), ['subprocess'], { stdio: ['pipe', 'pipe', 'inherit'] })

  stream.on('data', (message: Buffer) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(message.length)
    worker.stdin.write(Buffer.concat([prefix, message]))
  })

  let pending = Buffer.alloc(0)
  worker.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = pending.readUInt32LE(0)
      stream.write(pending.subarray(4, 4 + size))
      pending = pending.subarray(4 + size)
    }
  })

  stream.on('end', () => worker.stdin.end())
  stream.on('close', () => worker.kill())
  stream.on('error', () => worker.kill())
  worker.on('exit', () => stream.end())
}

const server = new Server()
server.addService(
  {
    Session: {
      path: SESSION_PATH,
      requestDeserialize: identity,
      requestSerialize: identity,
      requestStream: true,
      responseDeserialize: identity,
      responseSerialize: identity,
      responseStream: true,
    },
  },
  { Session: relay }
)
const port = await new Promise<number>((resolve, reject) => {
  server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
    if (error === null) {
      resolve(bound)
    } else {
      reject(error)
    }
  })
})

process.env['LOGFIRE_API_KEY'] = API_KEY
process.env['LOGFIRE_BASE_URL'] = `http://127.0.0.1:${String(port)}`

const spans = new InMemorySpanExporter()
logfire.configure({
  serviceName: 'example-agent-sandboxes-ai-sdk-smoke',
  diagLogLevel: logfire.DiagLogLevel.NONE,
  console: false,
  sendToLogfire: false,
  additionalSpanProcessors: [new SimpleSpanProcessor(spans)],
})
registerTelemetry(new OpenTelemetry())

// Wrapped to measure what the sandbox does with the tools: how many calls overlap, and how much data they return.
let inFlight = 0
let maxInFlight = 0
let bytesFetched = 0
const tools: ToolSet = Object.fromEntries(
  Object.entries(expenseTools).map(([name, t]) => [
    name,
    {
      ...t,
      execute: async (input: unknown, options: unknown) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          // A short delay, so that calls the sandbox starts together are still running together.
          await sleep(2)
          const result: unknown = await (t.execute as (input: unknown, options: unknown) => Promise<unknown>)(input, options)
          bytesFetched += JSON.stringify(result).length
          return result
        } finally {
          inFlight -= 1
        }
      },
    },
  ])
)

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
    step([runCodeCall('rates', RATES), runCodeCall('budgets', BUDGETS)], 'tool-calls'),
    step([runCodeCall('report', REPORT)], 'tool-calls'),
    step([{ type: 'text', text: ANSWER }], 'stop'),
  ],
})

assert.equal(await reviewTravel(model, tools), ANSWER)
server.forceShutdown()
// The exporter drops its spans on shutdown.
const finished = spans.getFinishedSpans()
await logfire.shutdown()

// The tools reach the model only as typed Python functions in the run_code description.
const [firstCall, , , lastCall] = model.doGenerateCalls
assert(firstCall !== undefined && lastCall !== undefined)
assert.deepEqual(
  firstCall.tools?.map((t) => t.name),
  ['run_code']
)
const runCodeTool = firstCall.tools?.[0]
assert(runCodeTool?.type === 'function')
assert.match(
  runCodeTool.description ?? '',
  /async def get_expenses\(\*, user_id: int, quarter: Literal\['Q1', 'Q2', 'Q3', 'Q4'\], category: Literal\['travel', 'meals', 'software'\]\) -> GetExpensesReturn:/u
)

const toolResults = new Map(
  lastCall.prompt
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .flatMap((part) => (part.type === 'tool-result' ? [[part.toolCallId, part.output] as const] : []))
)

// State kept between calls: every later call uses `people`, `items` and `currencies` from the first one.
assert.deepEqual(toolResults.get('setup'), {
  type: 'json',
  value: { people: 24, line_items: 368, currencies: ['CHF', 'EUR', 'GBP', 'USD'] },
})
assert.deepEqual(toolResults.get('budgets'), { type: 'json', value: 3 })

// Errors and recovery: the failing tool's message reaches the model, and the next call recovers in the same session.
const ratesResult = toolResults.get('rates')
assert(ratesResult?.type === 'error-text', `expected an error for the rates call, got ${JSON.stringify(ratesResult)}`)
assert.match(ratesResult.value, /The exchange rate service has no rate for CHF\. Finance uses a fixed Q3 rate of 1\.13 USD per CHF\./u)

// Larger data, small answer: hundreds of line items stay in the sandbox, and the model gets only the summary.
const reportResult = toolResults.get('report')
assert(reportResult?.type === 'json')
assertReport(reportResult.value as unknown as Report, expectedReport())
const reportBytes = JSON.stringify(reportResult.value).length
assert(bytesFetched > 20 * reportBytes, `fetched ${String(bytesFetched)} bytes for a ${String(reportBytes)} byte report`)

// Parallel calls: asyncio.gather runs host calls at the same time.
assert(maxInFlight > 1, 'asyncio.gather should run tool calls concurrently')

assert.equal(streams.length, 1)
const [stream] = streams
assert(stream !== undefined)
assert.equal(stream.path, SESSION_PATH)
assert.deepEqual(stream.metadata.get('authorization'), [`Bearer ${API_KEY}`])

// The one sandbox session joins the trace under the agent run's span, where codeMode() was created, and the tool
// calls each run_code call makes are nested under that call's span, failed ones marked as errors.
const runSpan = finished.find((span) => span.name === 'review travel')
assert(runSpan !== undefined, 'missing agent run span')
const { spanId, traceId } = runSpan.spanContext()
assert.deepEqual(stream.metadata.get('traceparent'), [`00-${traceId}-${spanId}-01`])
const runCodeSpans = finished
  .filter((span) => span.name === 'execute_tool run_code')
  .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])
assert.equal(runCodeSpans.length, 4)
const nestedCalls = runCodeSpans.map((runCodeSpan) => {
  const nested = finished.filter(
    (span) => span.name === 'run_code called {tool_name}' && span.parentSpanContext?.spanId === runCodeSpan.spanContext().spanId
  )
  const counts: Record<string, number> = {}
  for (const span of nested) {
    const name = String(span.attributes['tool_name'])
    counts[name] = (counts[name] ?? 0) + 1
  }
  return { counts, failed: nested.filter((span) => span.status.code === SPAN_STATUS_ERROR).length }
})
assert.deepEqual(nestedCalls, [
  { counts: { list_departments: 1, get_team_members: 4, get_expenses: 24 }, failed: 0 },
  { counts: { get_exchange_rate: 1 }, failed: 1 },
  { counts: { get_custom_budget: 24 }, failed: 0 },
  { counts: { get_exchange_rate: 4 }, failed: 1 },
])

console.log('agent sandboxes AI SDK smoke test passed')

// Python and JS round halves differently, so money is compared to the cent.
function assertReport(actual: Report, expected: Report): void {
  const close = (a: number, b: number, label: string): void => {
    assert(Math.abs(a - b) <= 0.011, `${label}: ${String(a)} is not ${String(b)}`)
  }
  assert.equal(actual.line_items, expected.line_items)
  assert.deepEqual(Object.keys(actual.department_totals_usd).sort(), Object.keys(expected.department_totals_usd).sort())
  for (const [department, total] of Object.entries(expected.department_totals_usd)) {
    close(actual.department_totals_usd[department] ?? Number.NaN, total, department)
  }
  assert.deepEqual(
    actual.over_budget.map(({ name, budget_usd }) => ({ name, budget_usd })),
    expected.over_budget.map(({ name, budget_usd }) => ({ name, budget_usd }))
  )
  actual.over_budget.forEach((row, i) => {
    const want = expected.over_budget[i]
    assert(want !== undefined)
    close(row.spent_usd, want.spent_usd, `${row.name} spent`)
    close(row.over_by_usd, want.over_by_usd, `${row.name} over by`)
  })
}
