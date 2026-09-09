---
'@pydantic/logfire-agent-control-mastra': minor
---

Add `@pydantic/logfire-agent-control-mastra`, the Mastra adapter for Logfire Agent Control. One processor on an agent's `inputProcessors` makes its instructions, model, model settings, and tool definitions editable from the Logfire UI without a deploy, and the agent keeps running on its code whenever nothing is published, Logfire is unreachable, or a published value cannot be understood. A managed tool rename lives on the wire and nowhere else: the tool record Mastra dispatches, traces, and stores from keeps its code-side keys, so `execute`, hooks, spans, and stored threads all still read the name your code gave the tool.
