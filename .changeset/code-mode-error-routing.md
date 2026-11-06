---
'@pydantic/logfire-ai-sdk-code-mode': patch
---

Route sandbox configuration and infrastructure failures to the developer instead of the model. Retry capacity checkout refusals once, report timeout and lost-session errors with specific guidance, and replay a server shutdown once when no host tool has been requested.

Add `onError` for developer-side reporting on UI streaming routes, using the AI SDK's `{ error }` event shape. Await this handler once per failed run without replacing the original error if reporting fails. Keep saved infrastructure failure markers distinct from successful empty results, discard stale printed output on replay, and preserve lost-state guidance for oversized replay results.

Wrap successful tool outputs in a `{ result: value }` transport envelope so valid Python dictionaries cannot collide with infrastructure failure markers. The model still receives the unwrapped value.

Route wrapped Agent Sandboxes errors by checking up to eight standard `Error.cause` objects. Wrapped errors keep the same capacity retry, timeout guidance, and shutdown replay as raw errors, while developers receive the original outer error.
