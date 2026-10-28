---
'logfire': patch
'@pydantic/logfire-node': patch
'@pydantic/logfire-browser': patch
'@pydantic/logfire-cf-workers': patch
'@pydantic/logfire-session-replay': patch
---

Apply scrubbing to every exported span, not only to the attributes passed to `logfire.span`, `logfire.info`, and the other API helpers. Spans from automatic instrumentation, attributes set after a span starts, span event attributes, span link attributes, span status messages, and Node.js log records are now scrubbed before export. Cloudflare Workers tail mode (`instrumentTail`) now scrubs too and accepts the `scrubbing` option.

Exception messages are now scrubbed consistently. Before, the `exception.message` attribute could be redacted while the same message stayed in the exception event, the span status, and the first line of the stack trace. The message and `Caused by` lines of `exception.stacktrace` are now scrubbed too; stack frame lines are kept.

In the browser, values of custom session attributes (`logfire.session.*`) are scrubbed too, matching only the application's own attribute name against the patterns. `configureFrontend` now removes query strings and fragments from every attribute whose key ends in `.url` (such as `web_vital.lcp.url`) and from the URLs in exception stack traces. Session replay applies `redactUrlPatterns` to error messages, sources, and stacks, and to console arguments, and `sessionReplay.captureGlobalErrors` is passed to the replay recorder when browser global error capture is off.
