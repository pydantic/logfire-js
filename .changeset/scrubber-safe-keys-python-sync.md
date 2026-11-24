---
'logfire': patch
---

Stop scrubbing SQL text in `db.query.text`. The scrubber's safe keys had drifted from the Python SDK, so a pg or mysql span lost its query whenever a table name matched a pattern, such as `llm_credentials` or `human_sessions`. The safe keys now also include `error.type`, `event.name`, `rpc.method`, and the `gen_ai` attributes for tool names, tool call IDs, token counts, models, the provider, and the conversation ID, as in the Python SDK.
