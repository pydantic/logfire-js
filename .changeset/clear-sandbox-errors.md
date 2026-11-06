---
'@pydantic/logfire-agent-sandboxes': patch
---

Export `AgentSandboxError`, `AgentSandboxRefusedError`, and `AgentSandboxConnectionError`. Wrap every connection and checkout failure in an Agent Sandboxes error with the original error on `cause`. Refusals expose `statusCode`, `statusMessage`, and `reason`, with Logfire configuration and capacity hints when applicable. Errors from operations on checked-out sessions remain unchanged.

Validate explicit and derived server URLs before checkout, and expand the troubleshooting guide with outer error messages, original causes, recovery guidance, and hosted sandbox limits.
