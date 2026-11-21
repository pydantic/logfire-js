# Agent Sandboxes example

Runs Python in [Logfire Agent Sandboxes](../../docs/agent-sandboxes.md) with `@pydantic/logfire-agent-sandboxes`: a first
snippet, state kept across runs, a host function with captured `print()` output, and a session forked into two branches.

## Run against Logfire

Copy `.env.example` to `.env` and set `LOGFIRE_API_KEY` to a project API key with the **Run code in this project's agent
sandboxes** permission. Set `LOGFIRE_TOKEN` too if you want this script's spans in Logfire.

```bash
pnpm run start
```

## Smoke test

```bash
pnpm run smoke
```

Runs `index.ts` against a local gRPC stand-in for the sandboxes server that relays each session stream to a
`monty subprocess` worker, with a fake API key. It checks the printed results and that every session stream carried the
bearer token and the demo span's trace context. CI runs it through `pnpm run test:examples` from the repository root.
