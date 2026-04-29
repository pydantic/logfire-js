# Evals Runtime Smokes

These scripts are manual checks for `logfire/evals` outside Node. Build the packages first, then run the target runtime smoke:

```sh
pnpm build
deno run --config scripts/runtime-smoke/deno.json --allow-read --allow-write scripts/runtime-smoke/evals-deno.ts
bun run scripts/runtime-smoke/evals-bun.ts
```

They intentionally are not wired into the main automation. They cover offline `Dataset.evaluate`, `setEvalAttribute` / `incrementEvalMetric`, `Dataset.toFile` / `Dataset.fromFile`, and online `withOnlineEvaluation`.
