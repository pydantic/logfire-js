/* eslint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/restrict-template-expressions, typescript/strict-boolean-expressions */
const scenario = process.argv[2]
assert(scenario === 'enabled' || scenario === 'disabled', 'usage: verify.mjs enabled|disabled')

const response = await fetch('http://127.0.0.1:4182/receipts')
assert(response.ok, `receipt request failed: ${String(response.status)}`)
const { receipts, state } = await response.json()
assert(state?.phase === 'complete', `fixture failed: ${String(state?.error ?? state?.phase)}`)
assert(typeof state.userAgent === 'string' && state.userAgent !== '', 'browser user agent was not recorded')

const spans = receipts.flatMap((body) => {
  const payload = JSON.parse(body)
  return (payload.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []))
})
const softNavigationSpans = spans.filter((span) => attributesOf(span)['web_vital.navigation_type'] === 'soft-navigation')
const documentSpan = spans.find((span) => {
  const attributes = attributesOf(span)
  return attributes['web_vital.navigation_type'] !== 'soft-navigation' && attributes['logfire.page.url.path'] === '/'
})
assert(documentSpan !== undefined, 'no document Web Vital span retained the initial navigation URL')
assert(attributesOf(documentSpan)['logfire.page.route'] === undefined, 'document span combines a historical URL with a route')

if (scenario === 'enabled') {
  assert(state.reportSoftNavs === true, 'enabled fixture did not enable soft navigation reporting')
  assert(state.softNavigationSupported === true, `browser lacks soft-navigation entries: ${state.userAgent}`)
  assert(softNavigationSpans.length > 0, 'no soft-navigation Web Vital span was exported')
  const productSpan = softNavigationSpans.find((span) => attributesOf(span)['logfire.page.url.path'] === '/products/123')
  assert(productSpan !== undefined, 'no soft-navigation span retained the product navigation URL')
  const attributes = attributesOf(productSpan)
  assert(Number(attributes['web_vital.navigation_id']) > 0, 'soft-navigation span lacks a non-zero navigation id')
  assert(attributes['logfire.page.url.full'] === 'http://127.0.0.1:4182/products/123', 'navigation URL was not sanitized')
  assert(attributes['logfire.page.route'] === undefined, 'soft-navigation span contains a callback-time route')
} else {
  assert(state.reportSoftNavs === false, 'disabled fixture enabled soft navigation reporting')
  assert(softNavigationSpans.length === 0, 'disabled fixture exported a soft-navigation Web Vital span')
}

console.log(
  JSON.stringify(
    {
      scenario,
      softNavigationSpanCount: softNavigationSpans.length,
      userAgent: state.userAgent,
      webVitalSpanNames: spans.filter((span) => span.name.startsWith('web_vital.')).map((span) => span.name),
    },
    null,
    2
  )
)

function attributesOf(span) {
  return Object.fromEntries((span.attributes ?? []).map((attribute) => [attribute.key, Object.values(attribute.value ?? {})[0]]))
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
