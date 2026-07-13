/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/restrict-template-expressions, typescript/strict-boolean-expressions */
import { gunzipSync } from 'node:zlib'

const scenario = process.argv[2]
assert(scenario === 'default' || scenario === 'opt-in', 'usage: verify.mjs default|opt-in')
const snapshot = await pollForEvidence(Date.now() + 10_000)
const expectedBase = `http://127.0.0.1:4178/${scenario}/`
const rawPage = `${expectedBase}?page_secret=${scenario}-page-secret#${scenario}-fragment-secret`
const expectedPage = scenario === 'default' ? expectedBase : rawPage
const rawFetch = '/api/fetch?fetch_secret=visible#fetch_fragment=visible'
const rawXhr = '/api/xhr?xhr_secret=visible#xhr_fragment=visible'
const rawPush = `http://127.0.0.1:4178/${scenario}/pushed?push_secret=visible#push_fragment=visible`
const rawReplace = `http://127.0.0.1:4178/${scenario}/replaced?replace_secret=visible#replace_fragment=visible`
const expectedFetch = scenario === 'default' ? 'http://127.0.0.1:4178/api/fetch' : rawFetch
const expectedXhr = scenario === 'default' ? 'http://127.0.0.1:4178/api/xhr' : rawXhr
const expectedPush = scenario === 'default' ? `http://127.0.0.1:4178/${scenario}/pushed` : rawPush
const expectedReplace = scenario === 'default' ? `http://127.0.0.1:4178/${scenario}/replaced` : rawReplace

const pageSpans = snapshot.spans.filter((span) => span.name === 'privacy-defaults-page-span')
assertEqual('manual page spans', pageSpans.length, 1)
assertEqual('page url.full', spanAttribute(pageSpans[0], 'logfire.page.url.full'), expectedPage)
assertEqual('page url.path', spanAttribute(pageSpans[0], 'logfire.page.url.path'), `/${scenario}/`)

const metaUrls = snapshot.events
  .filter((event) => event?.type === 4 && typeof event?.data?.href === 'string')
  .map((event) => event.data.href)
assertDeepEqual('rrweb Meta URLs', [...new Set(metaUrls)], [expectedPage])

const customEvents = snapshot.events.filter((event) => event?.type === 5)
const consoleEvents = customEvents.filter((event) => event?.data?.tag === 'logfire.console')
const networkEvents = customEvents.filter((event) => event?.data?.tag === 'logfire.network')
const navigationEvents = customEvents.filter((event) => event?.data?.tag === 'logfire.navigation')
assertEqual('network event count', networkEvents.length, 2)
assertEqual('navigation event count', navigationEvents.length, 3)
assertDeepEqual('network methods', networkEvents.map((event) => event.data.payload.method).sort(), ['GET', 'POST'])
assert(
  networkEvents.every((event) => event.data.payload.status === 200),
  'network status was not preserved'
)
assertDeepEqual('navigation kinds', navigationEvents.map((event) => event.data.payload.kind).sort(), ['pop', 'push', 'replace'])
assertEqual('fetch URL', eventByPayload(networkEvents, 'method', 'GET').data.payload.url, expectedFetch)
assertEqual('XHR URL', eventByPayload(networkEvents, 'method', 'POST').data.payload.url, expectedXhr)
assertEqual('push URL', eventByPayload(navigationEvents, 'kind', 'push').data.payload.url, expectedPush)
assertEqual('replace URL', eventByPayload(navigationEvents, 'kind', 'replace').data.payload.url, expectedReplace)
assertEqual('pop URL', eventByPayload(navigationEvents, 'kind', 'pop').data.payload.url, expectedPage)

const envelopeUrls = [...new Set(snapshot.replays.flatMap((replay) => replay.meta?.urls ?? []))]
assertDeepEqual('replay envelope meta.urls', envelopeUrls, [expectedPage, expectedPush, expectedReplace])

const fullSnapshot = snapshot.events.find((event) => event?.type === 2)
assert(fullSnapshot !== undefined, 'missing rrweb full snapshot')
const initialTextNode = findElementById(fullSnapshot.data?.node, 'initial-text')
const privateInputNode = findElementById(fullSnapshot.data?.node, 'private-input')
assert(initialTextNode !== undefined, 'missing initial text element in full snapshot')
assert(privateInputNode !== undefined, 'missing private input in full snapshot')
const initialText = collectText([initialTextNode])
const mutationText = collectText(snapshot.events.filter((event) => event?.type === 3))
const initialInputValue = privateInputNode.attributes?.value
assert(typeof initialInputValue === 'string' && /^\*+$/u.test(initialInputValue), 'initial input value was not masked')
assertEqual('raw DOM attribute caveat', privateInputNode.attributes?.['data-query-bearing'], '?attribute_secret=visible')

const inputValues = snapshot.events
  .filter((event) => event?.type === 3 && event?.data?.source === 5)
  .map((event) => event.data.text)
  .filter((value) => typeof value === 'string')
assert(inputValues.length > 0, 'missing rrweb input event')
assert(!inputValues.includes('input-event-secret'), 'input value was not masked')

if (scenario === 'default') {
  assertEqual('console events', consoleEvents.length, 0)
  assertDeepEqual('masked initial rendered text', initialText, ['*'.repeat('initial-visible-secret'.length)])
  assert(mutationText.includes('*'.repeat('mutated-visible-secret'.length)), 'mutated rendered text was not masked')
} else {
  assertEqual(
    'console opt-in marker count',
    consoleEvents.filter((event) => JSON.stringify(event.data.payload).includes('privacy-console-secret')).length,
    1
  )
  assertDeepEqual('raw initial rendered text', initialText, ['initial-visible-secret'])
  assert(mutationText.includes('mutated-visible-secret'), 'mutated rendered text opt-in marker missing')
}

console.log(
  JSON.stringify({ consoleEvents: consoleEvents.length, pageUrl: expectedPage, replayReceipts: snapshot.replays.length, scenario }, null, 2)
)

async function pollForEvidence(deadline) {
  const snapshot = await readSnapshot()
  if (snapshot.traces.length > 0 && snapshot.replays.length > 0) {
    return snapshot
  }
  if (Date.now() >= deadline) {
    throw new Error(`timed out waiting for ${scenario} receipts`)
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
  return pollForEvidence(deadline)
}

async function readSnapshot() {
  const response = await fetch('http://127.0.0.1:4178/receipts')
  assert(response.ok, `receipt request failed: ${response.status}`)
  const { receipts } = await response.json()
  const traces = receipts.filter((receipt) => receipt.kind === 'trace').map(decodeJson)
  const replays = receipts.filter((receipt) => receipt.kind === 'replay').map(decodeReplay)
  return {
    events: replays.flatMap((replay) => replay.events ?? []),
    replays,
    spans: traces.flatMap((payload) =>
      (payload.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []))
    ),
    traces,
  }
}

function collectText(events) {
  const values = []
  const visit = (value, key) => {
    if (key === 'textContent' && typeof value === 'string') {
      values.push(value)
    }
    if (Array.isArray(value)) {
      value.forEach((item) => {
        visit(item)
      })
    } else if (value !== null && typeof value === 'object') {
      Object.entries(value).forEach(([childKey, child]) => {
        visit(child, childKey)
      })
    }
  }
  for (const value of events) {
    visit(value)
  }
  return values
}

function findElementById(value, id) {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  if (value.attributes?.id === id) {
    return value
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const match = findElementById(child, id)
    if (match !== undefined) {
      return match
    }
  }
  return undefined
}

function eventByPayload(events, key, value) {
  const matches = events.filter((event) => event?.data?.payload?.[key] === value)
  assertEqual(`${key}=${value} event count`, matches.length, 1)
  return matches[0]
}

function spanAttribute(span, key) {
  return span.attributes?.find((attribute) => attribute.key === key)?.value?.stringValue
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
