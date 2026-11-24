import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vite-plus/test'

const PACKAGE_ROOT = resolve(import.meta.dirname, '../..')
const SDK_ENTRYPOINT = resolve(PACKAGE_ROOT, 'dist/index.js')
// Windows has no SIGTERM handlers: kill() ends the child before any listener runs.
const isWindows = process.platform === 'win32'
const PROCESS_EVENTS = ['beforeExit', 'SIGTERM', 'uncaughtExceptionMonitor', 'unhandledRejection']

type Scenario = 'sigterm' | 'unhandled-rejection'

interface ChildRecord {
  after?: Record<string, number>
  before?: Record<string, number>
  exported?: string
  ready?: true
}

interface ChildResult {
  code: number | null
  records: ChildRecord[]
}

// Each record goes to a file with appendFileSync: stdout to a pipe is asynchronous on macOS, and the child calls process.exit().
function childScript(scenario: Scenario, processHooks: boolean | undefined): string {
  const advanced = processHooks === undefined ? '{}' : `{ processHooks: ${String(processHooks)} }`
  return `
    import { appendFileSync } from 'node:fs'
    import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
    import { configure, info, shutdown } from ${JSON.stringify(SDK_ENTRYPOINT)}

    const record = (value) => appendFileSync(process.env.RECORDS_PATH, JSON.stringify(value) + '\\n')
    const counts = () => Object.fromEntries(${JSON.stringify(PROCESS_EVENTS)}.map((event) => [event, process.listenerCount(event)]))
    const exporter = {
      export(spans, done) {
        for (const span of spans) record({ exported: span.name })
        done({ code: 0 })
      },
      async forceFlush() {},
      async shutdown() {},
    }

    const before = counts()
    configure({
      additionalSpanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 60_000 })],
      advanced: ${advanced},
      console: false,
      metrics: false,
      nodeAutoInstrumentations: {},
      sendToLogfire: false,
      serviceName: 'process-hooks-itest',
    })
    record({ before, after: counts() })

    if (${JSON.stringify(scenario)} === 'sigterm') {
      process.on('SIGTERM', async () => {
        info('handler started')
        // Outlasts the SDK's own SIGTERM shutdown, like an application draining connections.
        await new Promise((resolve) => setTimeout(resolve, 500))
        info('drain finished')
        await shutdown()
        process.exit(7)
      })
      setInterval(() => undefined, 1_000)
      record({ ready: true })
    } else {
      Promise.reject(new Error('nobody handles this'))
    }
  `
}

const tempDirs: string[] = []

async function runChild(scenario: Scenario, processHooks: boolean | undefined): Promise<ChildResult> {
  const dir = mkdtempSync(join(tmpdir(), 'logfire-node-process-hooks-'))
  tempDirs.push(dir)
  const recordsPath = join(dir, 'records.jsonl')
  // Only the variables Node needs to run: inherited LOGFIRE_* or OTEL_* settings, such as a sample rate, change what is exported.
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], RECORDS_PATH: recordsPath }

  // The package root as cwd resolves the script's bare imports from this package's dependencies.
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(scenario, processHooks)], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  // A child whose shutdown hangs is killed, so the test fails on its exit code instead of leaving a process behind.
  const deadline = setTimeout(() => {
    child.kill('SIGKILL')
  }, 20_000)
  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => {
      clearTimeout(deadline)
      resolveExit(code)
    })
  })

  const readRecords = (): ChildRecord[] => {
    try {
      return readFileSync(recordsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as ChildRecord)
    } catch {
      return []
    }
  }

  if (scenario === 'sigterm') {
    await new Promise<void>((resolveReady, rejectReady) => {
      const readyBy = Date.now() + 20_000
      const poll = setInterval(() => {
        if (readRecords().some((entry) => entry.ready === true)) {
          clearInterval(poll)
          resolveReady()
        } else if (Date.now() > readyBy || child.exitCode !== null) {
          clearInterval(poll)
          rejectReady(new Error('child process did not get ready'))
        }
      }, 25)
    })
    child.kill('SIGTERM')
  }

  const code = await exited
  return { code, records: readRecords() }
}

function exportedNames(result: ChildResult): string[] {
  return result.records.flatMap((entry) => (entry.exported === undefined ? [] : [entry.exported]))
}

function listenerCounts(result: ChildResult): ChildRecord | undefined {
  return result.records.find((candidate) => candidate.before !== undefined)
}

const NO_LISTENERS = { SIGTERM: 0, beforeExit: 0, uncaughtExceptionMonitor: 0, unhandledRejection: 0 }
const SDK_LISTENERS = { SIGTERM: 1, beforeExit: 1, uncaughtExceptionMonitor: 1, unhandledRejection: 1 }

// Each child process loads the whole SDK, which takes about a second.
describe('process hooks in a Node process', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it.skipIf(isWindows)(
    'with the default hooks, loses the spans an application SIGTERM handler records after the SDK shut down',
    async () => {
      const result = await runChild('sigterm', undefined)

      expect(listenerCounts(result)).toEqual({ after: SDK_LISTENERS, before: NO_LISTENERS })
      // The SDK's listener runs first and shuts the SDK down while the handler waits on a timer. Only the span recorded before that wait reaches the exporter.
      expect(exportedNames(result)).toEqual(['handler started'])
      expect(result.code).toBe(7)
    },
    30_000
  )

  it.skipIf(isWindows)(
    'with processHooks off, installs no listeners and exports what the application SIGTERM handler records',
    async () => {
      const result = await runChild('sigterm', false)

      expect(listenerCounts(result)).toEqual({ after: NO_LISTENERS, before: NO_LISTENERS })
      expect(exportedNames(result)).toEqual(['handler started', 'drain finished'])
      expect(result.code).toBe(7)
    },
    30_000
  )

  it('with the default hooks, keeps the process alive after an unhandled rejection', async () => {
    const result = await runChild('unhandled-rejection', undefined)

    expect(exportedNames(result)).toEqual(['nobody handles this'])
    expect(result.code).toBe(0)
  }, 30_000)

  it('with processHooks off, leaves Node to crash on an unhandled rejection', async () => {
    const result = await runChild('unhandled-rejection', false)

    expect(listenerCounts(result)).toEqual({ after: NO_LISTENERS, before: NO_LISTENERS })
    expect(exportedNames(result)).toEqual([])
    expect(result.code).toBe(1)
  }, 30_000)
})
