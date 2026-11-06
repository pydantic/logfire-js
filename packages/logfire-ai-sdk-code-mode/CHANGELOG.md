# @pydantic/logfire-ai-sdk-code-mode

## 0.1.2

### Patch Changes

- Updated dependencies [ee912e4]
  - @pydantic/logfire-agent-sandboxes@0.2.2

## 0.1.1

### Patch Changes

- Updated dependencies [d967f55]
  - logfire@0.26.0
  - @pydantic/logfire-agent-sandboxes@0.2.1

## 0.1.0

### Minor Changes

- 75cc0de: Let Vercel AI SDK agents call their tools from Python running in Logfire Agent Sandboxes, in the way pydantic-ai CodeMode does.
  
  `codeMode()` turns AI SDK tools into typed async Python functions in one sandbox session and gives the model one `run_code` tool to call them from. It needs `ai` 7 and `@pydantic/monty` 1.5.0 or later as peer dependencies. It takes tool `approval` and `context`, enforces `limits` on time, nested calls and sizes, and joins the trace that is active when you call it.
