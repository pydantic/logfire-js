---
'@pydantic/logfire-ai-sdk-code-mode': patch
---

Keep Agent Sandboxes configuration and checkout failures out of model responses and report them through `onError`. Retry capacity failures once, replay safe shutdowns once, and give accurate timeout and lost-session guidance. Unexpected disconnects reset the session and return a model-retryable error.

Successful tool outputs now use `{ result: value }` in UI streams to distinguish them from failed calls. The model still receives the unwrapped value.
