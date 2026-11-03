// Runs index.ts against a local stand-in for the Agent Sandboxes server, so the example doubles as an
// end-to-end smoke test that needs no Logfire API key. Each WebSocket connection is relayed to a local
// `monty subprocess` worker, which speaks protobuf frames with a little-endian 4-byte length prefix.
import type { IncomingHttpHeaders } from 'node:http'

import { findMontyBinary } from '@pydantic/monty/node'
import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

const API_KEY = 'smoke-test-key'

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

// Set rather than deleted: index.ts loads dotenv, which only fills variables that are absent, so a developer's
// .env token would otherwise send spans to the relay's port.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOGFIRE_API_KEY: API_KEY,
  LOGFIRE_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
  LOGFIRE_SEND_TO_LOGFIRE: 'false',
}

const example = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'index.ts'], {
  cwd: import.meta.dirname,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
})
let stdout = ''
example.stdout.on('data', (chunk: Buffer) => {
  stdout += chunk.toString()
  process.stdout.write(chunk)
})
const [exitCode] = (await once(example, 'exit')) as [number | null]
server.close()

assert.equal(exitCode, 0, 'index.ts exited with an error')
assert.equal(
  stdout,
  [
    'first snippet: 42',
    'state across runs: 42',
    'host function: Sunny in London | Checking the weather',
    `forks: [ "[1, 'a']", "[1, 'b']" ]`,
    '',
  ].join('\n')
)

// One connection for the main session and one per fork, all inside the demo span's trace.
assert.equal(upgrades.length, 3)
const traceIds = new Set<string>()
for (const { headers, url } of upgrades) {
  assert.equal(url, '/monty-ws/')
  assert.equal(headers.authorization, `Bearer ${API_KEY}`)
  const traceparent = headers['traceparent']
  assert(typeof traceparent === 'string', 'missing traceparent header')
  traceIds.add(traceparent.split('-')[1] ?? '')
}
assert.equal(traceIds.size, 1, 'sessions were not in a single trace')

console.log('agent sandboxes smoke test passed')
