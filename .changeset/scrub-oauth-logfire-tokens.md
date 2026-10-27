---
'logfire': patch
---

Scrub OAuth-style token names (`access_token`, `refresh_token`, `id_token`, `bearer_token`), `logfire_token`, `passphrase`, `signing_key`, `hmac_key`, and Logfire token values (`pylf_v1_...`) from attributes by default, matching the Python SDK's default scrubbing patterns. camelCase keys such as `userIdToken` are scrubbed too. As in the Python SDK, string values that contain these phrases are also redacted, so a message like `'Failed to refresh access token'` is now scrubbed. A bare `token` and LLM usage fields such as `max_tokens` are still left alone.
