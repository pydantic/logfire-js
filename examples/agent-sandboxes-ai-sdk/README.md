# Agent Sandboxes with the Vercel AI SDK

An AI SDK agent that answers "Which Engineering team members exceeded their Q3 travel budget?" by writing one Python
program that calls its tools, instead of calling them one model turn at a time. The program runs in
[Logfire Agent Sandboxes](../../docs/agent-sandboxes.md). The scenario is ported from Monty's `expense_analysis`
example, which follows Anthropic's programmatic tool calling cookbook.

- [`expenses.ts`](expenses.ts) defines `get_team_members`, `get_expenses`, and `get_custom_budget` as ordinary AI SDK
  tools.
- [`runCode.ts`](runCode.ts) builds a `run_code` tool from them. It turns the tools into type-checked Python functions
  and runs the model's code in a sandbox session.
- [`agent.ts`](agent.ts) checks out one session with `agentSandboxes()` for the whole agent run and gives the model only
  `run_code`.

Every `run_code` call in a run uses the same session, like a REPL: variables and functions that one call defines are
still there in the next, so the model can build on earlier results. A session runs one call at a time, so `run_code`
queues calls the model makes in parallel.

In Logfire, the trace shows the agent run with the sandbox session under it, the model calls, a span for each
`run_code` call, and under each one a span for every tool call its Python code made.

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

Runs the agent with a mock model that replays fixed `run_code` calls, against a local stand-in for the sandboxes
server that relays each connection to a `monty subprocess` worker. The later calls, two of them in parallel, use what
the first one defined. It checks the tool results, that the model saw only `run_code`, that the run opened one
sandbox session in the agent run's trace, and that each call's tool calls nest under its `run_code` span. CI runs it
through `pnpm run test:examples` from the repository root.
