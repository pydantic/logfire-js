// Runs index.ts against a local stand-in for the Agent Sandboxes server, so the example doubles as an
// end-to-end smoke test that needs no Logfire API key. The stand-in serves Monty's gRPC session method and relays
// each session stream to a local `monty subprocess` worker, which speaks protobuf frames with a little-endian
// 4-byte length prefix.
import type { ServerDuplexStream } from '@grpc/grpc-js'

import { Metadata, Server, ServerCredentials } from '@grpc/grpc-js'
import { findMontyBinary } from '@pydantic/monty/node'
import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { once } from 'node:events'

const API_KEY = 'smoke-test-key'
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

// Set rather than deleted: index.ts loads dotenv, which only fills variables that are absent, so a developer's
// .env token would otherwise send spans to the relay's port.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOGFIRE_API_KEY: API_KEY,
  LOGFIRE_BASE_URL: `http://127.0.0.1:${String(port)}`,
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
server.forceShutdown()

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

// One session stream for the main session and one per fork, all inside the demo span's trace.
assert.equal(streams.length, 3)
const traceIds = new Set<string>()
for (const { metadata, path } of streams) {
  assert.equal(path, SESSION_PATH)
  assert.deepEqual(metadata.get('authorization'), [`Bearer ${API_KEY}`])
  const [traceparent] = metadata.get('traceparent')
  assert(typeof traceparent === 'string', 'missing traceparent metadata')
  traceIds.add(traceparent.split('-')[1] ?? '')
}
assert.equal(traceIds.size, 1, 'sessions were not in a single trace')

console.log('agent sandboxes smoke test passed')
