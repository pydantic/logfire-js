---
'@pydantic/logfire-node': minor
---

Add `@pydantic/logfire-node/agent-control`, the framework-neutral core of Logfire Agent Control: change an agent's instructions, model, model settings, and tool definitions from the Logfire UI without a deploy. An agent's config is one `agent__<name>` managed variable holding an `AgentConfig`, and every section of it is a patch — present means managed, absent means code, and a value that cannot be resolved or understood leaves the agent running exactly as written. `AgentControl` owns the variable and the baseline it publishes as the variable's `example`; `applyInstructions`, `applyToolDefinitions`, `applySettings`, and `buildBaseline` are pure functions over plain data, so a framework adapter is a thin layer on top rather than a fork of the contract. `@pydantic/logfire-node/agent-control/testing` exports the resets an adapter's test suite needs.
