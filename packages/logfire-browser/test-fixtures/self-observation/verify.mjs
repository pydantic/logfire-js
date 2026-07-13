/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/restrict-template-expressions, typescript/strict-boolean-expressions */
import { gunzipSync } from 'node:zlib'

const receiptUrl = 'http://127.0.0.1:4175/receipts'
const initial = await pollForRequiredEvidence()
assert(initial.frozen !== true, 'receipt window froze before the verifier observed the required evidence')
await delay(4_000)
await freezeSnapshot()
const final = await pollForFrozenSnapshot()
assert(final.frozen === true, 'receipt verifier requires an atomically frozen final snapshot')
assertBounded('trace', final.traces.length, 1, 6)
assertBounded('metric', final.metrics.length, 1, 6)
assertBounded('replay', final.replays.length, 1, 3)
assert(final.traces.length >= initial.traces.length, 'trace receipt count moved backwards')
assert(final.replays.length >= initial.replays.length, 'replay receipt count moved backwards')
assert(
  !(final.traces.length > initial.traces.length && final.replays.length > initial.replays.length),
  'trace and replay receipts both amplified during the active observation window'
)
assertRequiredEvidence(final)

console.log(
  JSON.stringify(
    {
      applicationHttpSpans: final.applicationHttpSpans.length,
      applicationRequests: final.applicationRequests,
      applicationReplayEvents: final.applicationReplayUrls.length,
      fcpMetric: true,
      metricReceipts: final.metrics.length,
      replayReceipts: final.replays.length,
      traceReceipts: final.traces.length,
    },
    null,
    2
  )
)

async function pollForRequiredEvidence() {
  return pollForRequiredEvidenceUntil(Date.now() + 10_000)
}

async function pollForFrozenSnapshot() {
  return pollForFrozenSnapshotUntil(Date.now() + 6_000)
}

async function freezeSnapshot() {
  const response = await fetch(`${receiptUrl}/freeze`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`failed to freeze receipt window: ${String(response.status)}`)
  }
}

async function pollForFrozenSnapshotUntil(deadline) {
  const latest = await readSnapshot()
  if (latest.frozen === true) {
    return latest
  }
  if (Date.now() >= deadline) {
    throw new Error('timed out waiting for the fixed active-window snapshot')
  }
  await delay(50)
  return pollForFrozenSnapshotUntil(deadline)
}

async function pollForRequiredEvidenceUntil(deadline, previous) {
  const latest = await readSnapshot()
  if (hasRequiredEvidence(latest)) {
    return latest
  }
  if (Date.now() >= deadline) {
    throw new Error(`timed out waiting for initial telemetry receipts: ${JSON.stringify((previous ?? latest).counts)}`)
  }
  await delay(50)
  return pollForRequiredEvidenceUntil(deadline, latest)
}

async function readSnapshot() {
  const response = await fetch(receiptUrl)
  if (!response.ok) {
    throw new Error(`receipt request failed: ${String(response.status)}`)
  }

  const { applicationRequests, frozen, receipts } = await response.json()
  const traces = receipts.filter((receipt) => receipt.kind === 'trace').map(decodeJson)
  const metrics = receipts.filter((receipt) => receipt.kind === 'metric').map(decodeJson)
  const replays = receipts.filter((receipt) => receipt.kind === 'replay').map(decodeReplay)
  const spans = traces.flatMap((payload) =>
    (payload.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []))
  )
  const metricNames = metrics.flatMap((payload) =>
    (payload.resourceMetrics ?? []).flatMap((resource) =>
      (resource.scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name))
    )
  )
  const replayNetworkUrls = replays
    .flatMap((payload) => payload.events ?? [])
    .filter((event) => event?.type === 5 && event?.data?.tag === 'logfire.network')
    .map((event) => event.data.payload?.url)
    .filter((url) => typeof url === 'string')

  return {
    applicationHttpSpans: spans.filter((span) => spanText(span).includes('/api/application')),
    applicationReplayUrls: replayNetworkUrls.filter((url) => url.includes('api/application')),
    applicationRequests,
    counts: { metric: metrics.length, replay: replays.length, trace: traces.length },
    frozen,
    metricNames,
    metrics,
    replays,
    replayNetworkUrls,
    spans,
    traces,
  }
}

function hasRequiredEvidence(snapshot) {
  return (
    snapshot.traces.length > 0 &&
    snapshot.metrics.length > 0 &&
    snapshot.replays.length > 0 &&
    snapshot.applicationRequests === 1 &&
    snapshot.spans.some((span) => span.name === 'self-observation-manual') &&
    snapshot.metricNames.includes('logfire.browser.web_vital.fcp') &&
    snapshot.applicationReplayUrls.length === 1 &&
    snapshot.applicationHttpSpans.length === 1
  )
}

function assertRequiredEvidence(snapshot) {
  assert(hasRequiredEvidence(snapshot), 'final snapshot is missing required application or FCP evidence')
  assertEqual('application proxy requests', snapshot.applicationRequests, 1)
  assertEqual('application replay network events', snapshot.applicationReplayUrls.length, 1)
  assertEqual('application HTTP client spans', snapshot.applicationHttpSpans.length, 1)

  for (const endpoint of ['client-traces', 'client-metrics', 'client-replay']) {
    assert(!snapshot.replayNetworkUrls.some((url) => url.includes(endpoint)), `replay captured SDK endpoint ${endpoint}`)
    assert(!snapshot.spans.some((span) => spanText(span).includes(endpoint)), `HTTP instrumentation captured SDK endpoint ${endpoint}`)
  }
}

function decodeJson(receipt) {
  return JSON.parse(Buffer.from(receipt.body, 'base64').toString('utf8'))
}

function decodeReplay(receipt) {
  return JSON.parse(gunzipSync(Buffer.from(receipt.body, 'base64')).toString('utf8'))
}

function spanText(span) {
  return JSON.stringify(span)
}

async function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function assertBounded(label, value, minimum, maximum) {
  assert(value >= minimum && value <= maximum, `${label} receipts ${String(value)} not in ${String(minimum)}..${String(maximum)}`)
}

function assertEqual(label, actual, expected) {
  assert(actual === expected, `${label}: expected ${String(expected)}, received ${String(actual)}`)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
