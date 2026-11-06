---
'@pydantic/logfire-ai-sdk-code-mode': minor
---

Let Vercel AI SDK agents call their tools from Python running in Logfire Agent Sandboxes, in the way pydantic-ai CodeMode does.

`codeMode()` turns AI SDK tools into typed async Python functions in one sandbox session and gives the model one `run_code` tool to call them from. It needs `ai` 7 and `@pydantic/monty` 1.5.0 or later as peer dependencies. It takes tool `approval` and `context`, enforces `limits` on time, nested calls and sizes, and joins the trace that is active when you call it.
