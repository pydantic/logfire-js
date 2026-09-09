# Live tests

Three assertions about a real `codex` process talking to a real model. **CI never runs them**: the
file is `codex.live.ts` rather than `*.test.ts` and sits behind its own `vite.live.config.ts`, so the
default `vp test` include cannot pick it up — the same way `@pydantic/logfire-session-replay` keeps
its Playwright specs out with `.pw.ts`.

## Why these are live rather than recorded

Every other integration in this repository can be pinned with a recorded HTTP exchange. This one
cannot: the Codex SDK does not make HTTP requests, it spawns the `codex` binary, and the binary makes
them from its own process with its own credentials. There is no fetch to intercept from JavaScript,
so a recorder here would record nothing and prove less than the offline suite already does.

What the offline suite in `src/__test__` proves is the whole mapping from a published value to the
argv a `codex` process is started with, against a stand-in binary. What it cannot prove is what the
_model_ then sees, since the prompt is assembled inside the binary. These three tests are exactly the
claims that live on the far side of that line:

1. **A published `developer_instructions` block changes what the model is told**, and a published
   `settings.thinking` is accepted by the provider rather than rejected on the request.
2. **`codex exec resume` does not re-inject a changed developer block** into a session that already
   persisted one. This is why the README says a published change is something new threads pick up.
3. **A published `model` whose provider id is not `openai` reaches that provider.** The test writes a
   `CODEX_HOME` holding one extra `model_providers` entry and no `auth.json`, so nothing but that
   entry can serve the turn.

## Running them

```bash
vp run @pydantic/logfire-agent-control-codex-sdk#test:live
```

Requirements:

- A logged-in Codex account (`codex login`, which writes `auth.json` into `$CODEX_HOME` or `~/.codex`). Without it every test in the file skips. The CLI binary itself comes from the `@openai/codex-sdk` devDependency, so nothing has to be on `PATH`.
- `OPENAI_API_KEY` in the environment for the third test only; without it that one skips. Pass it
  through the environment rather than putting it on a command line.

Each test runs one turn on a small model, in a fresh temporary working directory, with a prompt whose
only job is to echo one word back — no repository is read and nothing is written.

Two environment variables adjust the run:

| Variable                  | Default       | Why you would set it                                                                                                                                               |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CODEX_LIVE_MODEL`        | `gpt-5.6-sol` | An account that cannot reach the default.                                                                                                                          |
| `CODEX_LIVE_SANDBOX_MODE` | `read-only`   | A container that refuses the user namespace Codex's sandbox needs. Set it to the mode that machine's own `config.toml` uses and let the container be the boundary. |
