# Spike 01: Can browser cleanup safely support reconfiguration?

## Status

CONCLUSIVE

## Question

Can `@pydantic/logfire-browser` safely clean up configuration A and install configuration B in the same page while preserving manual Logfire spans, explicit-provider instrumentation spans, resource changes, and application-owned OpenTelemetry globals?

## Why It Blocks Planning

The answer selects the lifecycle architecture and the public cleanup contract. A child PRP cannot safely prescribe `trace.disable()` or merely recreate `WebTracerProvider` without knowing whether either approach preserves host application ownership and cached Logfire tracers.

## Hypotheses and Decision Rule

- If public OpenTelemetry APIs can identity-check and unregister only Logfire-owned trace, context, and propagation globals, choose full teardown and re-registration.
- If globals cannot be safely unregistered but a stable non-caching provider can route existing tracers across configuration generations, choose a stable delegating provider.
- If neither is feasible within a bounded stable-release change, specify terminal cleanup and deterministic refusal of later configuration.

## Minimal Experiment

- Environment and exact versions: commit `f57d9ec`; Node.js `24.14.1`; `@opentelemetry/api` `1.9.1`; `@opentelemetry/sdk-trace-web` `2.8.0`; JSDOM browser surface.
- Setup: import the built public browser package; capture explicit providers through a custom public instrumentation; use recording probe providers/exporters for global, manual Logfire, and direct-provider spans.
- Action: configure A, emit all span forms, clean up A, configure B with a different resource, and emit again. Separately install application-owned trace/context/propagation globals and test OpenTelemetry `disable()` calls. Finally route a tracer obtained before registration through a minimal non-caching delegating provider.
- Observation to capture: which provider starts each span; whether application globals survive; whether cached tracers switch; whether resource changes reach B.
- Safety and side-effect constraints: read-only repository; scratch code only under `/tmp`; no network, credentials, dependency changes, or external writes.

## Evidence

- Read-only Node ESM/JSDOM lifecycle probe against `packages/logfire-browser/dist/index.js`.
- `packages/logfire-browser/src/index.ts:477-492` creates, registers, and passes a fresh provider directly to instrumentations.
- `packages/logfire-browser/src/index.ts:539-601` stops instrumentation and shuts down the provider but does not unregister OpenTelemetry globals.
- `packages/logfire-api/src/logfireApiConfig.ts:86-99` caches the default manual tracer; `:126-129` refreshes it only when `otelScope` is explicitly configured.
- `packages/logfire-browser/src/index.test.ts:92-99` calls `trace.disable()` from the mock provider's `shutdown()`, unlike the real provider, so the existing unit test masks production lifecycle behavior.
- Installed OpenTelemetry sources show that `WebTracerProvider.register()` discards registration results; trace delegate inspection relies on deprecated `ProxyTracerProvider`; context and propagation expose no owner getters; and all three `disable()` APIs unregister globals without an identity check.

Observed routing after cleanup and configuration B:

```json
{
  "startsA": ["manual-a", "global-a", "direct-a", "manual-b", "global-b"],
  "startsB": ["direct-b"]
}
```

Observed with application-owned globals installed first:

```json
{
  "appStarts": ["manual-during-logfire", "manual-after-logfire-cleanup"],
  "logfireStarts": ["direct-logfire"],
  "globalStillApp": true
}
```

A minimal custom non-caching provider routed a tracer obtained before registration from generation A to B, including B's changed resource. This proves architectural feasibility, not production suitability.

## Result

- Outcome: CONCLUSIVE.
- Observed behavior: current cleanup followed by configure silently splits telemetry. Manual and global spans remain bound to A while explicit-provider spans reach B. Blanket `trace.disable()`, `context.disable()`, and `propagation.disable()` can delete or actively disable application-owned globals. Resetting globals alone also leaves the cached Logfire tracer on A.
- Decision: full teardown/re-register is rejected under cooperative page ownership. The roadmap must choose between a stable delegating provider and a documented terminal-cleanup refusal contract. The stable provider is the only observed route to genuine reconfiguration without unregistering globals.
- Rejected alternatives: blind global disable; provider recreation without tracer rebinding; relying on the existing mock test; using deprecated trace delegate inspection as an ownership guarantee.
- Representativeness limits: JSDOM did not exercise real-browser zone context propagation; multiple OpenTelemetry API major versions and metric globals were not tested; the delegating provider was a feasibility probe only.

## Planning Impact

- Roadmap or PRP sections/tasks/tests changed by this result: lifecycle handling becomes its own foundational child and must precede release validation. It requires real-OpenTelemetry lifecycle tests separate from the broad provider mocks.
- Consumer Contract, `CX-N` scenarios, or required evidence grade changed by this result: DIRECT evidence is required for public `configure()` plus manual `startSpan()`, explicit-provider instrumentation spans, resource changes, inactive-generation behavior, and application-owned globals.
- Remaining uncertainty: product choice between supported same-page reconfiguration via a stable delegating provider and terminal cleanup with deterministic refusal; duplicate bundle instances and real-browser async context behavior require child-level research if reconfiguration is selected.

## Cleanup

- Disposable artifacts removed: `/tmp/prp-023-otel-reconfiguration`.
- Repository and external state checked: no source, dependency, credential, or external state changes; only pre-existing untracked planning/report files remained before this durable record was added.
