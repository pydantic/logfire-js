---
'@pydantic/logfire-browser': patch
---

Warn about a `sampling.head` outside `0` to `1` or `NaN` and keep every trace. Before, a head above `1` or `NaN` kept every trace and a negative head dropped every trace, with no sign of the mistake. The Node SDK throws for such a value; the browser SDK warns through the OpenTelemetry diagnostic logger instead, so a mistake in the option cannot stop the page that calls `configure()`.
