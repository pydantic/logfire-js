# Agent Sandboxes with the Vercel AI SDK

An AI SDK agent that reviews a company's Q3 travel spending by writing Python that calls its tools, instead of calling
them one model turn at a time. The code runs in [Logfire Agent Sandboxes](https://pydantic.dev/docs/logfire/agent-sandboxes/typescript/). The scenario
extends Monty's `expense_analysis` example, which follows Anthropic's programmatic tool calling cookbook.

The data is generated from a fixed seed: 4 departments, 24 employees, and 368 travel line items in four currencies. The
model has to total each department in US dollars and find everyone over their budget. Several things a real agent run
needs are part of the task:

- **Large data, small answer.** The line items stay in the sandbox. The model gets back only the totals and the eight
  people over budget.
- **Parallel calls.** Code fetches all teams and expense lists at once with `asyncio.gather`.
- **Errors and recovery.** The rate service has no CHF rate, so `get_exchange_rate` raises an error whose message gives
  finance's fixed rate. The model sees it and retries. One employee is over budget by only $10.52, so skipping CHF gives
  a wrong answer.
- **State between calls.** Every `run_code` call in a run uses the same session, like a REPL, so later calls build on
  what earlier ones fetched.

The files:

- [`expenses.ts`](expenses.ts) defines the data and five ordinary AI SDK tools, each with an `outputSchema`, and
  computes the correct answer.
- [`agent.ts`](agent.ts) passes them to `codeMode()` from `@pydantic/logfire-ai-sdk-code-mode` and gives the model only the
  `run_code` tool it returns. `codeMode()` shows the tools as typed Python functions, the way pydantic-ai CodeMode does,
  checks out one session from `agentSandboxes()` on the first call, and closes it when the run ends.

In Logfire, the trace shows the agent run with the sandbox session under it, the model calls, a span for each
`run_code` call, and under each one a span for every tool call its Python code made, with failed calls marked as
errors.

## Run against Logfire

Copy `.env.example` to `.env` and set:

- `LOGFIRE_API_KEY`: a project API key with the **Run code in this project's agent sandboxes** permission.
- `OPENAI_API_KEY`: your OpenAI API key.
- `LOGFIRE_TOKEN`: optional, a write token to send this script's spans to Logfire.

```bash
pnpm run start
```

The script prints the agent's answer and then the correct one, so you can compare them.

## Smoke test

```bash
pnpm run smoke
```

Runs the agent with a mock model that replays four fixed `run_code` calls, against a local stand-in for the sandboxes
server that relays each gRPC session stream to a `monty subprocess` worker. The second step makes two calls in parallel, and one
of them fails on the CHF rate. The test checks that:

- the model sees only `run_code`, with typed function signatures;
- later calls reuse what the first call fetched, and the last call recovers from the failed one;
- the tool error message reaches the model;
- the report matches the correct answer, and is a small fraction of the data the tools returned;
- `asyncio.gather` runs tool calls concurrently;
- the run opens one sandbox session, in the agent run's trace, and each call's tool calls nest under its `run_code`
  span.

CI runs it through `pnpm run test:examples` from the repository root.
