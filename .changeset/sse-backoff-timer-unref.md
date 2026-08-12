---
'logfire': patch
---

Stop a pending SSE reconnect backoff from holding a Node process open. The remote variable provider unrefs its polling and debounce timers, but the reconnect backoff used a plain `setTimeout`. That backoff doubles up to a minute while the stream is unreachable, so after `shutdown()` the process could stay alive until it elapsed.
