---
title: RUM and Session Replay PRP Roadmap
description: PRP decomposition for moving Logfire browser RUM and rrweb session replay from the Platform POC into logfire-js.
---

# RUM and Session Replay PRP Roadmap

Status: planning. Created 2026-06-29.

This document scopes the overall Product Requirements Prompt (PRP) sequence for
Logfire JavaScript browser Real User Monitoring (RUM) and rrweb session replay.
It is intentionally an umbrella artifact, not an executable PRP. Executable
PRPs live in `plans/` and should remain small enough for one focused SDK PR.

## Source Context

The current Platform baseline is PR `#24916`, merged as commit
`0ce5f1153c` in `../platform` on 2026-06-25:

- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-instrumentation.tsx`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/browser-session.ts`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/web-vitals.ts`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-session-replay.ts`
- `../platform/src/packages/session-replay-sdk/`
- `../platform/src/services/logfire-backend/logfire_backend/routes/v1/replay.py`
- `../platform/src/packages/logfire-services/logfire_services/shared_services/session_replays.py`

The existing SDK handoff is:

- `docs/session-replay-integration.md`

## Decomposition

Use multiple PRPs. A single PRP would span SDK API design, OTel span schema,
browser session lifecycle, rrweb transport, package publishing, and Platform
migration. That is too broad for reliable validation.

### 020 - Browser RUM Foundation

File: `plans/020-browser-rum-foundation.md`

Scope:

- Add a supported browser span processor extension point, replacing Platform's
  local `@pydantic/logfire-browser` patch.
- Make browser session identity a `@pydantic/logfire-browser` concern.
- Emit `session.id` and compatibility `browser.session.id` on browser spans.
- Stamp current page URL attributes on browser spans.
- Keep all new behavior opt-in.

Depends on: none.

Unblocks:

- Core Web Vitals RUM spans.
- Session replay correlation even when replay is disabled or sampled out.
- Platform removal of its local browser SDK patch.

### 021 - Browser RUM Web Vitals

Scope:

- Add deliberate `web-vitals` dependency/version choice.
- Use `web-vitals/attribution`.
- Emit LCP, INP, CLS plus FCP and TTFB diagnostic reports.
- Start with spans for Platform compatibility and raw-sample drilldown.
- Preserve p75-friendly attributes such as `web_vital.name`,
  `web_vital.value`, `web_vital.rating`, and attribution fields.

Depends on:

- 020, so every vital span can be attributed to a browser session and page.

Key decisions:

- Public API shape for enabling web vitals.
- Whether to bundle `web-vitals` directly in `@pydantic/logfire-browser` or keep
  it optional.
- Whether `rum.webVitals` implies `rum.session`.

### 022 - Browser RUM Web Vitals Native Metrics

File: `plans/022-browser-rum-web-vitals-metrics.md`

Scope:

- Add native OpenTelemetry metric emission for Web Vitals in parallel with the
  PRP 021 spans, not instead of spans.
- Use Platform's existing `/v1/metrics/browser` proxy path and document the
  browser metrics proxy setup.
- Decide instrument shape, likely histogram-style p75 aggregation over
  low-cardinality dimensions such as metric name, route/path template, device
  class, and environment.
- Keep spans as raw samples or exemplars for session/replay correlation,
  attribution selectors, exact URL drilldown, and per-sample debugging.
- Add metric lifecycle/exporter cleanup to the browser SDK without changing the
  default trace-only behavior when metrics/RUM are disabled.

Depends on:

- 021, so metric emission can reuse the Web Vitals capture and attribute
  mapping.

Key decisions:

- Histogram vs gauge or another OTel instrument shape.
- Metric names, units, and dimensions.
- Whether the browser SDK should configure a metrics exporter automatically
  under `rum.webVitals`, or expose a separate metric exporter/proxy option.
- How Platform/Perses should query and display the native metric series.

### 023 - Standalone Session Replay Package

Scope:

- Create `packages/logfire-session-replay`.
- Move/adapt the Platform POC from `../platform/src/packages/session-replay-sdk`.
- Publish as `@pydantic/logfire-session-replay`.
- Keep `rrweb` and `fflate` isolated from the core `logfire` and browser
  tracing packages.
- Use a proxy-oriented public API: `replayUrl + headers`.
- Keep direct token usage as a lower-level trusted-runtime escape hatch, not the
  primary public browser path.
- Preserve the Platform chunk envelope and upload contract unless intentionally
  changing it with Platform.

Depends on: none for the standalone package, but 020 is needed for complete SDK
correlation.

Key decisions:

- Exact `rrweb` version pin.
- Public transport API naming and backwards compatibility with Platform POC.
- Awaitable `stop()`/cleanup semantics.

### 024 - Browser Session Replay Integration

Scope:

- Add optional `sessionReplay` config to `@pydantic/logfire-browser`.
- Add optional peer dependency on `@pydantic/logfire-session-replay`.
- Dynamically import replay only when configured.
- Pass SDK-owned session id and active trace context into replay.
- Stop/flush replay during browser SDK cleanup before shutting down the tracer
  provider.

Depends on:

- 020 for session identity.
- 023 for the replay package.

Key decisions:

- Exact `sessionReplay` config shape.
- How to surface missing optional peer dependency errors.

### Platform Migration PRP

This belongs in `../platform`, not this repo.

Scope:

- Consume the published SDK packages.
- Remove `src/packages/session-replay-sdk`.
- Remove the vendored `pydantic-logfire-session-replay-0.0.0.tgz`.
- Remove the local `@pydantic/logfire-browser` patch.
- Update the `rum` feature-flag setup to use the public SDK APIs.

Depends on:

- 020 at minimum to remove the local browser SDK patch.
- 023 and 024 to remove the vendored replay package cleanly.

## Dependency Order

```text
020 browser RUM foundation
  -> 021 browser RUM web vitals
  -> 022 browser RUM web vitals native metrics

023 standalone session replay package
  -> 024 browser session replay integration

020 browser RUM foundation
  -> 024 browser session replay integration

020 + 023 + 024
  -> Platform migration
```

## Shared Decisions To Clarify

- Public RUM API: one `rum` object, separate `browserSession` and `webVitals`
  options, or only low-level primitives first.
- Session attributes: emit `session.id` only, or emit both `session.id` and
  `browser.session.id` during the Platform compatibility window.
- RUM event format: spans first, metrics later, or spans plus metrics from the
  start.
- Dependency model: bundled dependencies versus optional peer dependencies for
  `web-vitals`, web auto-instrumentations, and replay.
- Replay auth: proxy-only public path with token as escape hatch, or support
  both equally.
- Defaults: sampling, privacy, and volume controls for public SDK behavior.
