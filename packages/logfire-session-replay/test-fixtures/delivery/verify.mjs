/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/restrict-plus-operands, typescript/strict-boolean-expressions */
import { gunzipSync } from 'node:zlib'

const scenario = process.argv[2]
if (!['unload', 'csp', 'retry-after', 'utf8'].includes(scenario)) {
  throw new Error('usage: verify.mjs <unload|csp|retry-after|utf8>')
}

try {
  const response = await fetch(`http://127.0.0.1:4177/fixture/status?scenario=${scenario}`)
  assert(response.ok, `status request failed: ${String(response.status)}`)
  const evidence = await response.json()
  const decoded = evidence.receipts.map((receipt) => ({
    ...receipt,
    envelope: JSON.parse(gunzipSync(Buffer.from(receipt.body, 'base64')).toString('utf8')),
  }))
  if (scenario !== 'unload') {
    assert(evidence.state?.phase === 'complete', `fixture failed: ${String(evidence.state?.error ?? evidence.state?.phase)}`)
  }

  if (scenario === 'unload') {
    verifyUnload(evidence, decoded)
  }
  if (scenario === 'csp') {
    verifyCsp(evidence, decoded)
  }
  if (scenario === 'retry-after') {
    verifyRetry(decoded)
  }
  if (scenario === 'utf8') {
    verifyUtf8(evidence, decoded)
  }

  console.log(JSON.stringify({ scenario, evidence: summarize(evidence, decoded) }, null, 2))
} finally {
  if (scenario === 'unload') {
    await fetch('http://127.0.0.1:4177/fixture/release?scenario=unload', { method: 'POST' })
  }
}

function verifyUnload(evidence, decoded) {
  assert(evidence.unloadReleasedAt === undefined, 'unload responses were released before verification')
  assert(decoded.length >= 2, `expected at least two lifecycle receipts, received ${String(decoded.length)}`)
  const ordered = [...decoded].sort((left, right) => left.seq - right.seq)
  assert(
    ordered.every((receipt) => receipt.marker === 'unload'),
    'unload authentication marker missing'
  )
  assert(
    ordered.every((receipt, index) => index === 0 || receipt.seq === ordered[index - 1].seq + 1),
    'sequences are not contiguous'
  )
  assert(ordered.reduce((total, receipt) => total + receipt.byteLength, 0) <= 48_000, 'compressed lifecycle aggregate exceeds 48,000 bytes')
  const bodies = ordered.map((receipt) => JSON.stringify(receipt.envelope))
  const firstIndex = bodies.findIndex((body) => body.includes('unload-marker-one'))
  const secondIndex = bodies.findIndex((body) => body.includes('unload-marker-two'))
  assert(firstIndex >= 0 && secondIndex >= 0, 'one or both unload markers are missing')
  assert(firstIndex < secondIndex, `unload markers were not split into ordered chunks: ${String(firstIndex)}, ${String(secondIndex)}`)
}

function verifyCsp(evidence, decoded) {
  assert(evidence.state.cspViolations === 1, `expected one blocked worker attempt, got ${String(evidence.state.cspViolations)}`)
  assert(evidence.state.errors.length === 0, `CSP fallback reported errors: ${JSON.stringify(evidence.state.errors)}`)
  assert(decoded.length === 2, `expected two CSP replay batches, received ${String(decoded.length)}`)
  assert(JSON.stringify(decoded[0].envelope).includes('csp-marker-one'), 'first CSP batch marker missing')
  assert(JSON.stringify(decoded[1].envelope).includes('csp-marker-two'), 'second CSP batch marker missing')
}

function verifyRetry(decoded) {
  assert(decoded.length === 2, `expected two retry attempts, received ${String(decoded.length)}`)
  assert(
    decoded.every((receipt) => receipt.marker === 'retry-after'),
    'retry authentication marker missing'
  )
  assert(decoded[0].seq === decoded[1].seq, 'retry changed sequence number')
  assert(decoded[0].body === decoded[1].body, 'retry changed request body')
  assert(decoded[1].receivedAt - decoded[0].receivedAt >= 1_000, 'retry started before Retry-After elapsed')
}

function verifyUtf8(evidence, decoded) {
  const applications = [...evidence.applicationReceipts].sort((left, right) => left.path.localeCompare(right.path))
  assert(applications.length === 2, `expected two application requests, received ${String(applications.length)}`)
  assert(
    applications.every((receipt) => receipt.byteLength === 6),
    `application byte counts were ${JSON.stringify(applications)}`
  )
  const events = decoded.flatMap((receipt) => receipt.envelope.events ?? [])
  const network = events.filter(
    (event) => event?.type === 5 && event?.data?.tag === 'logfire.network' && event?.data?.payload?.url?.includes('/application/')
  )
  assert(network.length === 2, `expected two captured network events, received ${String(network.length)}`)
  assert(
    network.every((event) => event.data.payload.reqBytes === 6),
    `captured byte counts were ${JSON.stringify(network)}`
  )
}

function summarize(evidence, decoded) {
  return {
    applicationReceipts: evidence.applicationReceipts,
    replayReceipts: decoded.map((receipt) => ({ byteLength: receipt.byteLength, receivedAt: receipt.receivedAt, seq: receipt.seq })),
    state: evidence.state,
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
