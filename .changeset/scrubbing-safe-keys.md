---
'logfire': minor
'@pydantic/logfire-browser': minor
'@pydantic/logfire-node': minor
'@pydantic/logfire-cf-workers': minor
---

Let applications declare attribute keys that scrubbing leaves alone.

Scrubbing checks attribute values as well as keys and runs on every exported span, including spans created with the OpenTelemetry tracer directly. An application that records code-defined labels, such as a step name containing `auth` or `session`, had them redacted, and the only way around it was a `callback` that kept each match.

The `scrubbing` option now accepts `safeKeys` (exact attribute keys) and `safeKeyPrefixes` (key prefixes such as `app.checkout.`). Neither the key nor the value of a matching top-level attribute is scrubbed, on span, span event, span link and log record attributes, in message template fields, and in the attributes passed to the API helpers. Nested keys, span status messages and log bodies are still scrubbed. An empty prefix is rejected, since it would exempt every key. The browser SDK forwards both options and keeps exempting its own session and URL attributes.
