---
'logfire': patch
---

Scrub OAuth-style token names (`access_token`, `refresh_token`, `id_token`, `bearer_token`), `logfire_token`, and Logfire token values (`pylf_v1_...`) from attributes by default, matching the Python SDK's default scrubbing patterns. A bare `token` and LLM usage fields such as `max_tokens` are still left alone.
