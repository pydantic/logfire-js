# Agent Sandboxes with the Vercel AI SDK

An AI SDK agent that answers "Which Engineering team members exceeded their Q3 travel budget?" by writing one Python
program that calls its tools, instead of calling them one model turn at a time. The program runs in
[Logfire Agent Sandboxes](../../docs/agent-sandboxes.md). The scenario is ported from Monty's `expense_analysis`
example, which follows Anthropic's programmatic tool calling cookbook.

- [`expenses.ts`](expenses.ts) defines `get_team_members`, `get_expenses`, and `get_custom_budget` as ordinary AI SDK
  tools.
- [`runCode.ts`](runCode.ts) defines a `run_code` tool with the AI SDK's `experimental_toolCaller`. It turns the tools
  routed to it into type-checked Python functions and runs the model's code with `agentSandboxes()`.
- [`agent.ts`](agent.ts) routes the three tools to `run_code` through `experimental_toolCallers`, so the model sees only
  `run_code`.

In Logfire, the trace shows the model calls, the `run_code` tool span, the sandbox session under it, and a span for
each tool call the Python code made.

`experimental_toolCaller` is experimental in AI SDK 7 and can change in a minor release.

## Run against Logfire

Copy `.env.example` to `.env` and set:

- `LOGFIRE_API_KEY`: a project API key with the **Run code in this project's agent sandboxes** permission.
- `OPENAI_API_KEY`: your OpenAI API key.
- `LOGFIRE_TOKEN`: optional, a write token to send this script's spans to Logfire.

```bash
pnpm run start
```

## Smoke test

```bash
pnpm run smoke
```

Runs the agent with a mock model that replays a fixed `run_code` call, against a local stand-in for the sandboxes
server that relays each connection to a `monty subprocess` worker. It checks the tool result, that the model saw only
`run_code`, and that the sandbox session and the nested tool calls joined the `run_code` span's trace. CI runs it
through `pnpm run test:examples` from the repository root.
