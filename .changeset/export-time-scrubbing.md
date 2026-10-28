---
'logfire': patch
'@pydantic/logfire-node': patch
'@pydantic/logfire-browser': patch
'@pydantic/logfire-cf-workers': patch
'@pydantic/logfire-session-replay': patch
---

Apply scrubbing to every exported span, not only to the attributes passed to `logfire.span`, `logfire.info`, and the other API helpers. Spans from automatic instrumentation, attributes set after a span starts, span event attributes, span link attributes, and Node.js log records are now scrubbed before export, as in the Python SDK. Cloudflare Workers tail mode (`instrumentTail`) now scrubs too and accepts the `scrubbing` option.

`exception.message` is no longer scrubbed, matching the Python SDK. Before, the attribute could be redacted while the same message stayed in the exception event and the span status.

In the browser, values of custom session attributes (`logfire.session.*`) are scrubbed too, matching only the application's own attribute name against the patterns. `configureFrontend` now removes query strings and fragments from every attribute whose key ends in `.url` (such as `web_vital.lcp.url`) and from the URLs in exception stack traces. Session replay applies `redactUrlPatterns` to error sources, error stacks, and console arguments, and `sessionReplay.captureGlobalErrors` is passed to the replay recorder when browser global error capture is off.
