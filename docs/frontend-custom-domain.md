---
title: Frontend custom domain
description: Route Logfire frontend observability and session replay uploads through a first-party domain.
---

# Frontend custom domain

Some content blockers reject requests to known observability domains even when
the user has consented to collection. To reduce false-positive blocking, route
browser telemetry through a neutral subdomain that you control, such as
`https://e.example.com`.

The restricted frontend application token is designed to be public. A custom
domain improves transport reliability; it is not needed to keep that token
secret, and it must not override the application's consent or privacy controls.

## Configure the SDK

Use a reverse proxy or edge worker, not a DNS CNAME directly to Logfire. The
proxy must terminate TLS for your domain and send requests to the regional
Logfire origin shown under **Frontend > Applications**. Choose a neutral
hostname without terms such as `analytics`, `tracking`, `telemetry`, `replay`,
or `logfire`.

When the proxy preserves Logfire's paths, pass its origin to
`configureFrontend()`:

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

logfire.configureFrontend({
  baseUrl: 'https://e.example.com',
  token: '<frontend-application-token>',
  sessionReplay: sessionReplayIntegration(),
})
```

Omit `sessionReplay` and its package import when the application uses frontend
observability without replay.

## Route ingest requests

The proxy routes these requests to the same paths on the application's regional
Logfire origin:

| Browser request                                      | Regional upstream                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /v1/traces`                                    | `https://logfire-us.pydantic.dev/v1/traces`                                    |
| `POST /v1/metrics`                                   | `https://logfire-us.pydantic.dev/v1/metrics`                                   |
| `POST /v1/replay/{session_id}?seq={sequence_number}` | `https://logfire-us.pydantic.dev/v1/replay/{session_id}?seq={sequence_number}` |

Replace the US origin with the exact origin generated for your application. Do
not send EU application data through the US origin, or the reverse.

## Cloudflare Worker example

This Worker accepts only the browser SDK's ingest requests, removes cookies,
preserves request bytes and replay sequence query parameters, and forwards CORS
preflights to Logfire:

```js
const UPSTREAM_ORIGIN = 'https://logfire-us.pydantic.dev'
const TELEMETRY_PATHS = new Set(['/v1/traces', '/v1/metrics'])
const REPLAY_PATH = /^\/v1\/replay\/[^/]+$/u
const FORWARDED_HEADERS = [
  'authorization',
  'content-type',
  'content-encoding',
  'origin',
  'access-control-request-method',
  'access-control-request-headers',
]

function isAllowedUrl(url) {
  if (TELEMETRY_PATHS.has(url.pathname)) return url.search === ''
  if (!REPLAY_PATH.test(url.pathname)) return false

  const query = [...url.searchParams]
  return query.length === 1 && query[0][0] === 'seq' && /^\d+$/u.test(query[0][1])
}

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url)
    if (!isAllowedUrl(incomingUrl)) return new Response('Not found', { status: 404 })
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
      return new Response('Method not allowed', { headers: { Allow: 'POST, OPTIONS' }, status: 405 })
    }

    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }

    const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, UPSTREAM_ORIGIN)
    return fetch(
      new Request(upstreamUrl, {
        body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
        headers,
        method: request.method,
        redirect: 'manual',
      })
    )
  },
}
```

Bind the Worker to the custom subdomain before changing the SDK. Other CDNs and
reverse proxies can use the same fixed routing contract.

## Production requirements

A production proxy should:

- preserve the request body without parsing, decompressing, or recompressing it
- preserve `Authorization`, `Content-Type`, and `Content-Encoding`
- never forward browser cookies
- allow only `POST` and CORS `OPTIONS` on the paths above, rather than becoming
  a general Logfire proxy
- preserve upstream status codes so the SDK can retry retryable failures
- avoid caching ingest requests or responses
- enforce request-size and rate limits appropriate for the application
- allow the custom origin in the application's Content Security Policy
  `connect-src`; same-origin proxy paths are already covered by `'self'`

The example forwards Logfire's wildcard ingest CORS response. To restrict a
cross-origin subdomain further, answer preflights at the edge for the exact app
origins, `POST`, and `Authorization`, `Content-Type`, and `Content-Encoding`.
Do not enable credentialed wildcard CORS.

## Use custom public paths

`configureFrontend()` requires the path-preserving layout above. If a blocker
also targets those paths, use the lower-level `configure()` API with neutral
proxy URLs, then map those fixed public URLs to the three regional upstream
paths:

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

const headers = () => ({ Authorization: 'Bearer <frontend-application-token>' })

logfire.configure({
  traceUrl: 'https://e.example.com/i/a',
  traceExporterHeaders: headers,
  metrics: {
    metricUrl: 'https://e.example.com/i/b',
    metricExporterHeaders: headers,
  },
  sessionReplay: {
    ...sessionReplayIntegration(),
    replayUrl: 'https://e.example.com/i/c',
    headers,
  },
  autoInstrumentations: true,
  rum: { webVitals: { metrics: true } },
})
```

In this example, the proxy maps `/i/a` to `/v1/traces`, `/i/b` to
`/v1/metrics`, and `/i/c/{session_id}?seq={sequence_number}` to the equivalent
`/v1/replay/...` path. Keep the destination fixed in proxy configuration; never
accept an upstream URL from the browser.

## Verify the deployment

Use browser developer tools to confirm that:

1. Trace, metric, and replay uploads go only to the custom domain.
2. CORS preflights and uploads return successful status codes.
3. New data appears under the expected frontend application in Logfire.

For a proxy that authenticates application sessions or injects a normal project
write token server-side, follow the
[authenticated backend proxy guidance](packages/browser.md#authenticated-application-proxy).
