/* eslint-disable no-underscore-dangle */
import * as logfire from '../../dist/index.js'
import type { BrowserConfigureHandle, BrowserSessionReplayHandle } from '../../dist/index.js'

import { emitWebVital, hasWebVitalsRegistration } from './webVitalsRecorder'

interface AcceptanceState {
  bStopCalls: number
  earlyMode: string
  earlyRecording: boolean
  error?: string
  failedMode: string
  failedRecording: boolean
  flushAfterStopIdentity: boolean
  fullCleanupIdentity: boolean
  legacyCallable: boolean
  liveMode: string
  liveRecording: boolean
  operationOrder: string[]
  phase: 'starting' | 'complete' | 'failed'
  replayStopIdentity: boolean
  staleHandleIsolated: boolean
  stoppedMode: string
  stoppedRecording: boolean
  webVitalCallbackCalled: boolean
}

declare global {
  interface Window {
    __logfireOptionalFeatureApi: AcceptanceState
  }
}

const state: AcceptanceState = {
  bStopCalls: 0,
  earlyMode: 'unset',
  earlyRecording: true,
  failedMode: 'unset',
  failedRecording: true,
  flushAfterStopIdentity: false,
  fullCleanupIdentity: false,
  legacyCallable: false,
  liveMode: 'unset',
  liveRecording: false,
  operationOrder: [],
  phase: 'starting',
  replayStopIdentity: false,
  staleHandleIsolated: false,
  stoppedMode: 'unset',
  stoppedRecording: true,
  webVitalCallbackCalled: false,
}
window.__logfireOptionalFeatureApi = state

run().catch(fail)

async function run(): Promise<void> {
  await fetch('/receipts/reset', { method: 'POST' })

  const legacy: () => Promise<void> = logfire.configure({ traceUrl: '/traces/legacy' })
  state.legacyCallable = typeof legacy === 'function' && !('sessionReplay' in legacy)
  await legacy()

  let releaseLoad!: () => void
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve
  })
  let aStopCalls = 0
  const cleanupA: BrowserConfigureHandle = logfire.configure({
    batchSpanProcessorConfig: { maxExportBatchSize: 32, scheduledDelayMillis: 10 },
    rum: { webVitals: true },
    sessionReplay: {
      load: async () => {
        await loadGate
        return {
          startSessionReplay: () => ({
            mode: 'full' as const,
            recording: true,
            flush: async () => {
              state.operationOrder.push('flush')
              return Promise.resolve()
            },
            getSessionId: () => 'fixture-a',
            stop: async () => {
              aStopCalls++
              state.operationOrder.push('stop')
              return Promise.resolve()
            },
          }),
        }
      },
      replayUrl: '/replay',
    },
    traceUrl: '/traces/a',
  })
  const replayA: BrowserSessionReplayHandle = requireReplay(cleanupA)
  state.earlyMode = replayA.mode
  state.earlyRecording = replayA.recording
  // @ts-expect-error Session identity intentionally remains on getBrowserSessionId().
  assert(replayA.getSessionId === undefined, 'replay facade leaked session identity')

  const flushPromise = replayA.flush()
  const stopPromise = replayA.stop()
  state.replayStopIdentity = replayA.stop() === stopPromise
  state.flushAfterStopIdentity = replayA.flush() === stopPromise
  releaseLoad()
  await Promise.all([flushPromise, stopPromise])
  await waitFor(hasWebVitalsRegistration)
  await tick()
  assert(aStopCalls === 1, `A stop calls: ${String(aStopCalls)}`)
  assert(state.operationOrder.join(',') === 'flush,stop', `operation order: ${state.operationOrder.join(',')}`)

  logfire.startSpan('manual-after-replay-stop').end()
  state.webVitalCallbackCalled = emitWebVital()
  const cleanupPromiseA = cleanupA()
  state.fullCleanupIdentity = cleanupA() === cleanupPromiseA
  await cleanupPromiseA
  emitWebVital()

  const cleanupB = logfire.configure({
    sessionReplay: {
      load: () => ({
        startSessionReplay: () => ({
          mode: 'buffer' as const,
          recording: true,
          flush: async () => Promise.resolve(),
          getSessionId: () => 'fixture-b',
          stop: async () => {
            state.bStopCalls++
            return Promise.resolve()
          },
        }),
      }),
      replayUrl: '/replay',
    },
    traceUrl: '/traces/b',
  })
  await tick()
  const replayB = requireReplay(cleanupB)
  state.liveMode = replayB.mode
  state.liveRecording = replayB.recording
  await replayA.stop()
  state.staleHandleIsolated = state.bStopCalls === 0
  await cleanupB()
  state.stoppedMode = replayB.mode
  state.stoppedRecording = replayB.recording

  const failedCleanup = logfire.configure({
    sessionReplay: {
      load: async () => Promise.reject(new Error('fixture replay load failure')),
      replayUrl: '/replay',
    },
    traceUrl: '/traces/failed',
  })
  const failedReplay = requireReplay(failedCleanup)
  await failedReplay.flush()
  await failedReplay.stop()
  state.failedMode = failedReplay.mode
  state.failedRecording = failedReplay.recording
  await failedCleanup()

  state.phase = 'complete'
  await fetch('/receipts/state', {
    body: JSON.stringify(state),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const status = document.querySelector('#status')
  if (status !== null) {
    status.textContent = 'complete'
  }
}

function requireReplay(cleanup: BrowserConfigureHandle): BrowserSessionReplayHandle {
  if (cleanup.sessionReplay === undefined) {
    throw new Error('configured replay facade is missing')
  }
  return cleanup.sessionReplay
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  if (predicate()) {
    return
  }
  if (attempts === 0) {
    throw new Error('timed out waiting for Web Vitals registration')
  }
  await tick()
  return waitFor(predicate, attempts - 1)
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function fail(error: unknown): void {
  state.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  state.phase = 'failed'
  const status = document.querySelector('#status')
  if (status !== null) {
    status.textContent = state.error
  }
}
