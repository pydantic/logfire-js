/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/restrict-template-expressions, typescript/strict-boolean-expressions */
import { gunzipSync } from 'node:zlib'

const scenario = process.argv[2]
assert(scenario === 'normal' || scenario === 'hostile', 'usage: verify.mjs normal|hostile [--phase <phase>]')
const phase = parsePhase(scenario)
const snapshot = await pollForEvidence(Date.now() + 30_000, scenario, phase)

if (scenario === 'normal') {
  verifyNormal(snapshot, phase)
} else {
  verifyHostile(snapshot)
}

console.log(
  JSON.stringify(
    {
      metricPoints: snapshot.metricPoints.length,
      phase,
      replayReceipts: snapshot.replays.length,
      scenario,
      sessionIds: [...new Set(snapshot.spans.map((span) => attribute(span, 'session.id')).filter(Boolean))],
      spanCount: snapshot.spans.length,
    },
    null,
    2
  )
)

function verifyNormal(snapshot, requestedPhase) {
  const named = new Map(snapshot.spans.map((span) => [span.name, span]))
  const before = required(named, 'normal-before-reload')
  const firstSession = attribute(before, 'session.id')
  const beforeRoute = '/projects/:project_id'
  const beforePath = '/projects/123'
  const beforeUrl = 'http://127.0.0.1:4180/projects/123'
  const representatives = [
    before,
    required(named, 'normal-duration'),
    required(named, 'normal-error'),
    requiredScopeWithRoute(snapshot.spans, 'instrumentation-document-load', beforeRoute),
    requiredScopeWithRoute(snapshot.spans, 'instrumentation-fetch', beforeRoute),
    requiredScopeWithRoute(snapshot.spans, 'instrumentation-user-interaction', beforeRoute),
    requiredScopeWithRoute(snapshot.spans, 'instrumentation-xml-http-request', beforeRoute),
    requiredSpanWithRoute(snapshot.spans, (span) => span.name.startsWith('web_vital.'), beforeRoute, 'Web Vital'),
  ]
  for (const span of representatives) {
    assertEqual(`${span.name} route`, attribute(span, 'logfire.page.route'), beforeRoute)
    assertEqual(`${span.name} page URL path`, attribute(span, 'logfire.page.url.path'), beforePath)
    assertEqual(`${span.name} page URL full`, attribute(span, 'logfire.page.url.full'), beforeUrl)
    assertEqual(`${span.name} session tier`, attribute(span, 'logfire.session.account_tier'), 'pro')
  }

  const firstReplays = snapshot.replays.filter(({ sessionId }) => sessionId === firstSession)
  assert(firstReplays.length > 0, 'missing first-session replay chunks')
  assertReplayChunks('first session', firstReplays, dimensions('pro', 1))
  if (requestedPhase === 'before-reload') {
    return
  }

  const after = required(named, 'normal-after-reload')
  assertEqual('same-tab persisted session', attribute(after, 'session.id'), firstSession)
  assertEqual('route after reload', attribute(after, 'logfire.page.route'), beforeRoute)
  assertEqual('persisted account tier', attribute(after, 'logfire.session.account_tier'), 'pro')
  if (requestedPhase === 'after-reload') {
    return
  }

  const rotated = required(named, 'normal-after-rotation')
  const rotatedSession = attribute(rotated, 'session.id')
  assert(rotatedSession !== firstSession, 'idle expiry did not rotate the browser session')
  assertEqual('route after state change', attribute(rotated, 'logfire.page.route'), '/settings')
  assertEqual('rotated account tier', attribute(rotated, 'logfire.session.account_tier'), 'enterprise')
  assertEqual('callback count', attribute(required(named, 'normal-callback-count'), 'acceptance.callback_count'), 2)

  const rotatedReplays = snapshot.replays.filter(({ sessionId }) => sessionId === rotatedSession)
  assert(rotatedReplays.length > 0, 'missing rotated-session replay chunks')
  assertReplayChunks('rotated session', rotatedReplays, dimensions('enterprise', 2))

  const omitted = required(named, 'normal-route-omitted')
  assertEqual('omitted route callback', attribute(omitted, 'logfire.page.route'), undefined)
  assertEqual('omitted route keeps page URL', attribute(omitted, 'logfire.page.url.path'), beforePath)

  assert(snapshot.metricPoints.length > 0, 'missing Web Vital metric points')
  for (const point of snapshot.metricPoints) {
    assertDeepEqual('Web Vital metric attribute keys', (point.attributes ?? []).map(({ key }) => key).sort(), [
      'web_vital.name',
      'web_vital.rating',
    ])
  }
}

function verifyHostile(snapshot) {
  const span = snapshot.spans.find(({ name }) => name === 'hostile-dimensions')
  assert(span !== undefined, 'missing hostile span')
  assertEqual('session id retained', typeof attribute(span, 'session.id'), 'string')
  assertEqual('default URL retained', attribute(span, 'logfire.page.url.path'), '/hostile/')
  assertEqual('throwing route omitted', attribute(span, 'logfire.page.route'), undefined)
  assertEqual('replay remained active', attribute(span, 'logfire.session_replay.active'), true)

  const sessionDimensions = Object.fromEntries(
    (span.attributes ?? [])
      .filter(({ key }) => key.startsWith('logfire.session.'))
      .map(({ key, value }) => [key.slice('logfire.session.'.length), otlpValue(value)])
  )
  assertEqual('hostile cap', Object.keys(sessionDimensions).length, 20)
  assertEqual('valid value retained', sessionDimensions.account_tier, 'pro')
  assertEqual('Unicode boundary retained', sessionDimensions.valid_unicode, '🚀'.repeat(200))
  for (const key of ['Invalid', 'invalid_infinity', 'invalid_nested', 'invalid_string', 'broken', 'valid_18']) {
    assertEqual(`invalid or capped ${key}`, sessionDimensions[key], undefined)
  }
  assert(snapshot.replays.length > 0, 'missing hostile replay')
  assertReplayChunks('hostile session', snapshot.replays, sessionDimensions)
}

function assertReplayChunks(label, replays, expectedDimensions) {
  for (const replay of replays) {
    assertEqual(`${label} envelope version`, replay.envelope.version, 1)
    assertDeepEqual(
      `${label} seq ${String(replay.envelope.meta?.seq)} dimensions`,
      replay.envelope.meta?.sessionAttributes,
      expectedDimensions
    )
  }
}

function dimensions(accountTier, generation) {
  return {
    account_tier: accountTier,
    app_region: 'eu',
    beta_user: true,
    generation,
  }
}

async function pollForEvidence(deadline, selectedScenario, requestedPhase) {
  const snapshot = await readSnapshot(selectedScenario)
  if (hasRequiredEvidence(snapshot, selectedScenario, requestedPhase)) {
    return snapshot
  }
  if (Date.now() >= deadline) {
    throw new Error(`timed out waiting for ${selectedScenario} ${requestedPhase} receipts`)
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
  return pollForEvidence(deadline, selectedScenario, requestedPhase)
}

async function readSnapshot(selectedScenario) {
  const response = await fetch('http://127.0.0.1:4180/receipts')
  assert(response.ok, `receipt request failed: ${response.status}`)
  const { receipts } = await response.json()
  const serviceName = `rum-dimensions-${selectedScenario}`
  const traces = receipts.filter(({ kind }) => kind === 'trace').map(decodeJson)
  const metrics = receipts.filter(({ kind }) => kind === 'metric').map(decodeJson)
  const spans = traces.flatMap((payload) => collectSpans(payload, serviceName))
  const sessionIds = new Set(spans.map((span) => attribute(span, 'session.id')).filter(Boolean))
  const replays = receipts
    .filter(({ kind }) => kind === 'replay')
    .map((receipt) => ({
      envelope: decodeReplay(receipt),
      sessionId: new URL(receipt.url, 'http://127.0.0.1').pathname.split('/').at(-1),
    }))
    .filter(({ sessionId }) => sessionIds.has(sessionId))
  return {
    metricPoints: metrics.flatMap((payload) => collectMetricPoints(payload, serviceName)),
    replays,
    spans,
  }
}

function collectSpans(payload, serviceName) {
  return (payload.resourceSpans ?? [])
    .filter((resource) => resourceAttribute(resource.resource, 'service.name') === serviceName)
    .flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) =>
        (scope.spans ?? []).map((span) => ({
          ...span,
          scopeName: scope.scope?.name,
        }))
      )
    )
}

function collectMetricPoints(payload, serviceName) {
  return (payload.resourceMetrics ?? [])
    .filter((resource) => resourceAttribute(resource.resource, 'service.name') === serviceName)
    .flatMap((resource) =>
      (resource.scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).flatMap((metric) => metric.histogram?.dataPoints ?? []))
    )
}

function hasRequiredEvidence(snapshot, selectedScenario, requestedPhase) {
  if (selectedScenario === 'hostile') {
    return snapshot.spans.some(({ name }) => name === 'hostile-dimensions') && snapshot.replays.length > 0
  }
  if (requestedPhase === 'before-reload') {
    return snapshot.spans.some(({ name }) => name === 'normal-before-reload') && snapshot.replays.length > 0
  }
  if (requestedPhase === 'after-reload') {
    return snapshot.spans.some(({ name }) => name === 'normal-after-reload')
  }
  return (
    snapshot.spans.some(({ name }) => name === 'normal-after-rotation') &&
    snapshot.spans.some(({ name }) => name === 'normal-route-omitted') &&
    new Set(snapshot.replays.map(({ sessionId }) => sessionId)).size >= 2 &&
    snapshot.metricPoints.length > 0
  )
}

function parsePhase(selectedScenario) {
  const phaseIndex = process.argv.indexOf('--phase')
  const defaultPhase = selectedScenario === 'normal' ? 'rotated' : 'hostile'
  if (phaseIndex === -1) {
    return defaultPhase
  }
  const requested = process.argv[phaseIndex + 1]
  const allowed = selectedScenario === 'normal' ? ['before-reload', 'after-reload', 'rotated'] : ['hostile']
  assert(allowed.includes(requested), `invalid phase ${requested} for ${selectedScenario}`)
  return requested
}

function requiredScopeWithRoute(spans, scopeFragment, route) {
  return requiredSpanWithRoute(spans, (span) => span.scopeName?.includes(scopeFragment), route, scopeFragment)
}

function requiredSpanWithRoute(spans, predicate, route, label) {
  const span = spans.find((candidate) => predicate(candidate) && attribute(candidate, 'logfire.page.route') === route)
  assert(span !== undefined, `missing ${label} span with route ${route}`)
  return span
}

function attribute(span, key) {
  return otlpValue(span?.attributes?.find((item) => item.key === key)?.value)
}

function resourceAttribute(resource, key) {
  return otlpValue(resource?.attributes?.find((item) => item.key === key)?.value)
}

function otlpValue(value) {
  return value?.stringValue ?? value?.boolValue ?? value?.intValue ?? value?.doubleValue
}

function required(map, key) {
  const value = map.get(key)
  assert(value !== undefined, `missing span ${key}`)
  return value
}

function decodeJson(receipt) {
  return JSON.parse(Buffer.from(receipt.body, 'base64').toString('utf8'))
}

function decodeReplay(receipt) {
  return JSON.parse(gunzipSync(Buffer.from(receipt.body, 'base64')).toString('utf8'))
}

function assertDeepEqual(label, actual, expected) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
  )
}

function assertEqual(label, actual, expected) {
  assert(actual === expected, `${label}: expected ${String(expected)}, received ${String(actual)}`)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
