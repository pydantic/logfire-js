---
'@pydantic/logfire-agent-control-codex-sdk': minor
---

Add `@pydantic/logfire-agent-control-codex-sdk`, the Agent Control adapter for the OpenAI Codex SDK: wrap the options you already pass to `new Codex(...)` and `startThread(...)`, give the agent a name, and its developer instructions, its base prompt, its model, and its reasoning effort become editable from the Logfire UI without a deploy. Codex assembles its prompt and defines its tools inside the `codex` binary, so the two writable instruction blocks lower onto real config keys while the blocks Codex computes per session are published as seams, and a published tool definition or sampling setting is reported through `onUnmatched` rather than dropped where nobody would see it. The published config is applied per thread, at thread start, because that is the last moment Codex accepts any of it.
