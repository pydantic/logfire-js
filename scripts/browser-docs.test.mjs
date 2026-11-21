import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const landing = readFileSync(new URL('../docs/packages/browser.md', import.meta.url), 'utf8')

test('existing browser setup headings remain link targets', () => {
  assert.match(landing, /^## Install$/m)
  assert.match(landing, /^## Configure$/m)
})

test('historical browser guide fragments remain at the original URL', () => {
  const historicalFragments = [
    'errors',
    'errors-and-replay-profile',
    'verify-the-setup',
    'manual-client-events',
    'minimum-level-filtering',
    'rum-session-identity',
    'route-names',
    'react-router',
    'tanstack-router',
    'vue-router',
    'nextjs-pages-router',
    'nextjs-app-router',
    'sveltekit',
    'resource-timing-detail',
    'rum-web-vitals',
    'rum-long-animation-frames',
    'session-replay',
    'custom-span-processors',
    'baggage-span-attributes',
    'optional-backend-proxy',
    'first-party-ingest-domain',
    'authenticated-application-proxy',
    'runtime-lifecycle',
    'pending-spans',
    'python-backend-proxy-telemetry-only',
  ]
  const anchors = [...landing.matchAll(/<span id="([^"]+)"><\/span>/g)].map((match) => match[1])
  assert.equal(new Set(anchors).size, anchors.length, 'Compatibility anchors must be unique')
  for (const fragment of historicalFragments) {
    assert.ok(anchors.includes(fragment), `Missing compatibility anchor: ${fragment}`)
  }
})
