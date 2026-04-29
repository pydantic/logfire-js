# pydantic-evals parity: remaining gaps

Differences between `logfire-api`'s evals module and Python `pydantic-evals`. Each entry is either an open gap, a JS runtime limitation, or a deliberate design choice.

## Open gaps

### `disableEvaluation` is a process-wide counter

Python uses a `ContextVar` so disabling evaluation is scoped to the current async context. JS uses a global counter, so concurrent requests interfere with each other. A proper fix needs `AsyncLocalStorage` and a non-trivial rewrite of the dispatch path.

### Online evaluation: no JSON-schema sidecar on `recordReturn`

`encodeReturnAttribute` handles primitives, errors, and unserializable values cleanly, but doesn't emit the Logfire-style JSON-schema sidecar attribute that Python writes alongside the encoded return value. `logfire-api` doesn't currently have an equivalent helper to generate it.

## JavaScript runtime limitations

### `extractArgs` parses `fn.toString()` with a regex

Python uses `inspect.signature` to recover parameter names. JS has no equivalent for arbitrary functions, so we regex-parse the stringified source. This is fragile (minifiers, decorators, default values with commas, etc.) and documented as such in the code.

## By-design

### `LLMJudge` requires a caller-supplied judge function

Python's `LLMJudge` has a model/model-settings concept baked in. The JS version is BYO: callers pass a function that returns the grading payload. Consequently `model` / `model_settings` are absent from `LLMJudge.toJSON()`. This keeps `logfire-api` free of an LLM-client dependency.

### Online evaluation: async-only task functions

The `EvaluationTask` type is restricted to async functions. Sync support would add complexity for negligible benefit in a JS runtime.

### No rich-text terminal rendering of reports

Python uses `rich` to render evaluation reports as tables. JS has no equivalent dependency; reports are returned as plain data for the caller to render.

### JSON Schema: no `evaluators` opt-out for user-defined evaluators

Built-in evaluators define a `static jsonSchema()` and produce typed schemas. User-defined evaluators get a loose `properties: {}` fallback (see `jsonSchema.ts:88`). Python has a way to opt a user evaluator out of schema generation entirely; JS doesn't. Niche.
