/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/restrict-template-expressions, typescript/strict-boolean-expressions */

const scenario = process.argv[2]
if (scenario !== 'sequential' && scenario !== 'application-owned') {
  throw new Error('usage: verify.mjs <sequential|application-owned>')
}

const response = await fetch(`http://127.0.0.1:4176/receipts/${scenario}`)
if (!response.ok) {
  throw new Error(`receipt request failed: ${String(response.status)}`)
}
const { receipts, state } = await response.json()
assert(state !== undefined, 'fixture did not record its acceptance state')
assert(state.phase === 'complete', `fixture phase was ${String(state.phase)}: ${String(state.error ?? '')}`)
assert(state.scenario === scenario, `fixture recorded the wrong scenario: ${String(state.scenario)}`)
const spansByEndpoint = new Map()
for (const receipt of receipts) {
  const payload = JSON.parse(Buffer.from(receipt.body, 'base64').toString('utf8'))
  const spans = (payload.resourceSpans ?? []).flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map((span) => ({
        ...span,
        resourceAttributes: Object.fromEntries(
          (resource.resource?.attributes ?? []).map((attribute) => [attribute.key, attribute.value?.stringValue])
        ),
      }))
    )
  )
  spansByEndpoint.set(receipt.endpoint, [...(spansByEndpoint.get(receipt.endpoint) ?? []), ...spans])
}

if (scenario === 'sequential') {
  const overlapError = 'logfire-browser: a configuration is already active; await its cleanup before configuring again'
  assert(state.activeOverlap === overlapError, `unexpected active overlap result: ${String(state.activeOverlap)}`)
  assert(state.cleaningOverlap === overlapError, `unexpected cleaning overlap result: ${String(state.cleaningOverlap)}`)
  assert(state.inactiveRecording === false, 'cached tracer recorded between generations')
  assert(
    typeof state.tailSamplingCalls === 'number' && state.tailSamplingCalls > 0,
    `B tail sampler was not exercised: ${String(state.tailSamplingCalls)}`
  )
  assert(
    Object.values(state.activeContextChecks ?? {}).length === 8 &&
      Object.values(state.activeContextChecks ?? {}).every((value) => value === true),
    `Zone context checks failed: ${JSON.stringify(state.activeContextChecks)}`
  )
  assertExactGeneration('a', 'A', ['cached-child-a', 'cached-parent-a', 'instrumentation-a', 'manual-child-a', 'manual-parent-a'])
  assertExactGeneration('b', 'B', ['cached-child-b', 'cached-parent-b', 'instrumentation-b', 'manual-child-b', 'manual-parent-b'])
  assertParentChild('a', 'cached-parent-a', 'cached-child-a')
  assertParentChild('a', 'manual-parent-a', 'manual-child-a')
  assertParentChild('b', 'cached-parent-b', 'cached-child-b')
  assertParentChild('b', 'manual-parent-b', 'manual-child-b')
  assert((spansByEndpoint.get('app') ?? []).length === 0, 'sequential scenario unexpectedly exported application spans')
} else {
  assert(state.applicationPropagationAfterCleanup === true, 'application propagator was not retained after cleanup')
  assertExactGeneration('a', 'logfire', ['instrumentation-logfire', 'manual-logfire'])
  assertExactGeneration('app', 'application', [
    'application-after-child',
    'application-after-parent',
    'application-before',
    'application-during',
  ])
  assertParentChild('app', 'application-after-parent', 'application-after-child')
  assert((spansByEndpoint.get('b') ?? []).length === 0, 'application-owned scenario unexpectedly exported B spans')
}

console.log(
  JSON.stringify(
    {
      endpoints: Object.fromEntries([...spansByEndpoint].map(([endpoint, spans]) => [endpoint, spans.map((span) => span.name).sort()])),
      scenario,
      state,
    },
    null,
    2
  )
)

function assertExactGeneration(endpoint, generation, expectedNames) {
  const spans = spansByEndpoint.get(endpoint) ?? []
  const names = spans.map((span) => span.name).sort()
  assertEqual(`${endpoint} span names`, names, [...expectedNames].sort())
  assert(
    spans.every((span) => span.resourceAttributes.generation === generation),
    `${endpoint} contained a span with the wrong generation resource`
  )
}

function assertParentChild(endpoint, parentName, childName) {
  const spans = spansByEndpoint.get(endpoint) ?? []
  const parent = spans.find((span) => span.name === parentName)
  const child = spans.find((span) => span.name === childName)
  assert(parent !== undefined && child !== undefined, `missing ${parentName}/${childName}`)
  assert(child.parentSpanId === parent.spanId, `${childName} is not a child of ${parentName}`)
  assert(child.traceId === parent.traceId, `${childName} does not share ${parentName}'s trace`)
}

function assertEqual(label, actual, expected) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
  )
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
