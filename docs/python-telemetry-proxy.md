---
title: Python telemetry proxy
description: Forward browser traces, logs, and metrics through an authenticated Python backend.
---

# Python telemetry proxy

The restricted frontend application token supports [direct browser ingest](packages/browser.md).
Use a proxy when you need application authentication, origin restrictions, or rate limits.

Python backends can use the `logfire.forward_export_request_starlette` and
`logfire.forward_export_request` helpers to create a trace, log, and metric
telemetry ingress endpoint without exposing the write token.

For FastAPI/Starlette, use `logfire.forward_export_request_starlette` in an endpoint.
This skeleton rejects every request until you implement `verify_user_session`.
Replace it with your application's authentication and origin checks before use:

```py title="main.py"
from fastapi import Depends, FastAPI, HTTPException, Request

import logfire

logfire.configure()
app = FastAPI()


async def verify_user_session():
    # Replace with your application's authentication and origin checks.
    raise HTTPException(status_code=403, detail='Telemetry proxy not configured')


@app.post('/logfire-proxy/{path:path}', dependencies=[Depends(verify_user_session)])
async def proxy_browser_telemetry(request: Request):
    return await logfire.forward_export_request_starlette(request)
```

The `{path:path}` route parameter is required. `forward_export_request_starlette` rejects paths other than `/v1/traces`, `/v1/logs`, and `/v1/metrics` so that it can forward to the appropriate Logfire backend endpoint.

These Python helpers cannot forward session replay. Replay is a separate
capability and must not be routed through this telemetry-only endpoint. A replay
proxy needs its own authenticated route that:

- accepts `POST /v1/replay/{session_id}?seq={sequence}`
- percent-encodes the session id as one path segment and the sequence as one
  query value
- forwards the request bytes and their `Content-Type` and
  `Content-Encoding` unchanged
- adds the Logfire write token only on the server
- applies the application's authentication, exact origin policy, rate limits,
  and request-size limit

This repository's
[`examples/browser`](https://github.com/pydantic/logfire-js/tree/main/examples/browser)
and
[`examples/browser-rum-replay`](https://github.com/pydantic/logfire-js/tree/main/examples/browser-rum-replay)
projects contain runnable JavaScript development proxies for traces, metrics,
and replay. They bind to loopback and are reference helpers for local
development, not a production proxy deployment design.

For Django, Flask, Litestar, or a custom HTTP server, use `forward_export_request`
directly. The following is a framework-adaptation sketch, not a complete route;
authenticate the request first and replace `CustomFrameworkResponse` with your
framework's response class:

```py title="main.py"
import logfire

logfire.configure()


def my_custom_proxy_route(request):
    response = logfire.forward_export_request(
        path=request.path.removeprefix('/logfire-proxy'),
        headers=request.headers,
        body=request.read(),
    )
    # Replace CustomFrameworkResponse with your framework's response class.
    return CustomFrameworkResponse(
        content=response.content,
        status_code=response.status_code,
        headers=response.headers,
    )
```

Protect this endpoint in production. Treat browser telemetry ingress like any other externally reachable write endpoint: clients can be numerous, retry requests, duplicate payloads, or send malicious data. Use your normal authentication, session, CORS, and rate-limiting controls. Configure CORS for the exact app origins that should send telemetry; do not use wildcard credentialed CORS.

Caveats:

- These functions only forward requests directly to Logfire. If you have alternative backends configured, you will need to proxy to them manually.
- The helpers validate the ingest path, content type, and request-size limit.
  They do not scrub sensitive span attributes or enforce your application's
  permissions; forwarded telemetry still needs its own privacy controls.
- Requests are placed in a queue and forwarded in a background thread. The queue is limited to 1000 requests and 64MB of memory. If the queue is full, new requests will be dropped. This is to prevent overwhelming your backend with large volumes of telemetry data, which could be used in a DoS attack.
