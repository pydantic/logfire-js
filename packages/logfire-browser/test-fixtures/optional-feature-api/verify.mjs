/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions */
import { readFile } from 'node:fs/promises'

const response = await fetch('http://127.0.0.1:4179/receipts')
if (!response.ok) {
  throw new Error(`receipt request failed: ${String(response.status)}`)
}
const { receipts, state } = await response.json()
assert(state?.phase === 'complete', `fixture failed: ${String(state?.error ?? state?.phase)}`)
assert(state.legacyCallable === true, 'legacy callable cleanup was not preserved')
assert(state.earlyMode === 'off' && state.earlyRecording === false, 'lazy state was not conservative')
assert(state.replayStopIdentity === true, 'repeated replay stop did not preserve promise identity')
assert(state.flushAfterStopIdentity === true, 'flush after stop did not join the stop promise')
assert(state.fullCleanupIdentity === true, 'repeated full cleanup did not preserve promise identity')
assert(JSON.stringify(state.operationOrder) === JSON.stringify(['flush', 'stop']), 'early operation order was not preserved')
assert(state.staleHandleIsolated === true && state.bStopCalls === 1, 'stale A handle affected B ownership')
assert(state.failedMode === 'off' && state.failedRecording === false, 'failed replay state was not conservative')
assert(state.webVitalCallbackCalled === true, 'controlled Web Vitals callback was not invoked')
assert(state.liveMode === 'buffer' && state.liveRecording === true, 'ready replay getters were not live')
assert(state.stoppedMode === 'off' && state.stoppedRecording === false, 'stopped replay getters were not conservative')

const spans = receipts.flatMap((body) => {
  const payload = JSON.parse(body)
  return (payload.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []))
})
const manual = spans.filter((span) => span.name === 'manual-after-replay-stop')
const webVitals = spans.filter((span) => span.name === 'web_vital.fcp')
assert(manual.length === 1, `expected one post-replay-stop manual span, received ${String(manual.length)}`)
assert(webVitals.length === 1, `expected exactly one pre-full-cleanup Web Vital span, received ${String(webVitals.length)}`)
const webVitalAttributes = Object.fromEntries(webVitals[0].attributes.map((attribute) => [attribute.key, attribute.value?.stringValue]))
assert(webVitalAttributes['logfire.span_type'] === 'log', 'Web Vital span is not an exact Logfire log')

const declarations = await Promise.all(
  ['index.d.ts', 'index.d.cts'].map(async (declaration) => ({
    declaration,
    source: await readFile(new URL(`../../dist/${declaration}`, import.meta.url), 'utf8'),
  }))
)
for (const { declaration, source } of declarations) {
  assert(source.includes('interface BrowserConfigureHandle'), `${declaration} lacks BrowserConfigureHandle`)
  assert(source.includes('readonly sessionReplay?: BrowserSessionReplayHandle'), `${declaration} lacks optional replay facade`)
  assert(/readonly mode: ["']full["'] \| ["']buffer["'] \| ["']off["']/u.test(source), `${declaration} lacks replay mode`)
  assert(!/interface BrowserSessionReplayHandle[\s\S]*?getSessionId/u.test(source), `${declaration} leaks replay session identity`)
  assert(source.includes('Replay startup touches'), `${declaration} lacks initial replay touch documentation`)
  assert(source.includes('subsequent replay events only peek'), `${declaration} lacks replay non-refresh documentation`)
}

console.log(JSON.stringify({ spanNames: spans.map((span) => span.name), state }, null, 2))

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
