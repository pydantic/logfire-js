## Goal

Expose a typed `resourceAttributes` configuration option in the Node.js and Browser Logfire SDKs so users can attach arbitrary OpenTelemetry resource attributes without mutating `OTEL_RESOURCE_ATTRIBUTES`.

This PRP is intentionally scoped to:

- `@pydantic/logfire-node`
- `@pydantic/logfire-browser`

Cloudflare Workers support and resource detector configuration are out of scope for this first pass.

## Why

- Users currently need to serialize and percent-encode `OTEL_RESOURCE_ATTRIBUTES` before `logfire.configure()` to set attributes such as `service.namespace`, `service.instance.id`, `process.pid`, or `app.installation.id`.
- Logfire already exposes native columns for several resource attributes, so a typed SDK option improves ergonomics without introducing new telemetry semantics.
- The Browser SDK already constructs an OpenTelemetry resource directly, so Node and Browser can share the same public option even though only Node supports environment-based resource detection.

## Success Criteria

- [ ] `@pydantic/logfire-node.configure()` accepts `resourceAttributes?: Attributes` from `@opentelemetry/api`.
- [ ] Node-created resources include user-provided resource attributes on traces, logs, metrics, and the managed variables runtime context.
- [ ] Node preserves existing `OTEL_RESOURCE_ATTRIBUTES` behavior: environment resource attributes continue to override code-provided resource attributes.
- [ ] First-class Logfire options such as `serviceName`, `serviceVersion`, `environment`, and `codeSource` continue to work and take precedence over conflicting keys in `resourceAttributes`.
- [ ] `@pydantic/logfire-browser.configure()` accepts `resourceAttributes?: Attributes` from `@opentelemetry/api`.
- [ ] Browser-created resources include user-provided resource attributes while preserving existing browser, service, environment, and telemetry SDK defaults.
- [ ] Tests cover Node and Browser resource composition.
- [ ] Package documentation and release metadata mention the new option.

## Context

### Key Files

- `packages/logfire-node/src/logfireConfig.ts` — Node public config types, internal resolved config, env resolution, and `configure()` storage.
- `packages/logfire-node/src/sdk.ts` — Node OpenTelemetry `Resource` construction and the source of attributes passed to `NodeSDK`, `MeterProvider`, and `configureVariables()`.
- `packages/logfire-node/src/__test__/logfireConfig.test.ts` — test file for `configure()` option storage and env interaction.
- `packages/logfire-node/src/__test__/sdk.test.ts` — pattern for testing Node SDK startup with mocked `NodeSDK` instances.
- `packages/logfire-browser/src/index.ts` — Browser public config type and `WebTracerProvider` resource construction.
- `packages/logfire-node/README.md` — Node usage documentation.
- `packages/logfire-browser/README.md` — Browser usage documentation.
- `.changeset/` — add a changeset because this is a public package API addition; package changelogs are generated from changesets.

### External References

- [GitHub issue #113](https://github.com/pydantic/logfire-js/issues/113) — original feature request and example API shape.
- [OpenTelemetry JavaScript resources docs](https://opentelemetry.io/docs/languages/js/resources/) — resources represent the entity producing telemetry; custom resources can be set in code; env-provided resource values take precedence over code-provided values.

### Gotchas

- Use `Attributes` from `@opentelemetry/api`, not `Record<string, unknown>`, so callers get OpenTelemetry attribute value typing.
- Do not accept a full OpenTelemetry `Resource` object. That would let users replace SDK-owned telemetry attributes and would make Browser and Node behavior harder to keep aligned.
- Preserve Node's existing `envDetector` merge semantics. `OTEL_RESOURCE_ATTRIBUTES` must still override code config.
- `resourceAttributes` should be stable resource metadata. It should not be documented as the right place for per-span, per-request, or sensitive browser user data.
- Node currently sets `autoDetectResources: false` and manually merges `envDetector`. Do not switch to `NodeSDK` auto detection as part of this change.
- Browser tests will likely need to mock `WebTracerProvider`, `OTLPTraceExporter`, and `registerInstrumentations`, and stub `navigator`.

## Implementation Blueprint

### Data Models

Add a shared public option shape independently in the Node and Browser config interfaces:

```ts
import type { Attributes } from '@opentelemetry/api'

interface LogfireConfigOptions {
  /**
   * Additional OpenTelemetry resource attributes for the entity producing telemetry.
   */
  resourceAttributes?: Attributes
}
```

For Node, also add the resolved internal field:

```ts
interface LogfireConfig {
  resourceAttributes: Attributes
}
```

### Tasks

```yaml
Task 1: Add Node config storage
  MODIFY packages/logfire-node/src/logfireConfig.ts:
    - Import type `Attributes` from `@opentelemetry/api`.
    - Add `resourceAttributes?: Attributes` to `LogfireConfigOptions`.
    - Add `resourceAttributes: Attributes` to `LogfireConfig`.
    - Initialize `DEFAULT_LOGFIRE_CONFIG.resourceAttributes` to `{}`.
    - Store `cnf.resourceAttributes ?? {}` in `configure()`.
  PATTERN: packages/logfire-node/src/logfireConfig.ts currently resolves serviceName, serviceVersion, environment, and codeSource before assigning `logfireConfig`.

Task 2: Merge Node resource attributes
  MODIFY packages/logfire-node/src/sdk.ts:
    - Build a user resource from `logfireConfig.resourceAttributes`.
    - Build the existing Logfire resource from service/environment/codeSource/telemetry SDK attributes.
    - Merge resources so first-class Logfire options override conflicting `resourceAttributes` keys when defined.
    - Merge `detectResources({ detectors: [envDetector] })` last to preserve env precedence.
    - Keep the final resource object as the single resource passed to `NodeSDK`, `MeterProvider`, and `configureVariables()`.
  PATTERN: packages/logfire-node/src/sdk.ts:98 currently builds the resource and passes `resource.attributes` to managed variables.

Task 3: Add Node tests
  MODIFY packages/logfire-node/src/__test__/logfireConfig.test.ts:
    - Assert `configure({ resourceAttributes })` stores the object on `logfireConfig`.
  MODIFY packages/logfire-node/src/__test__/sdk.test.ts:
    - Start the SDK with configured resource attributes.
    - Assert the mocked `NodeSDK` receives a resource containing a custom attribute such as `service.namespace`.
    - Assert a first-class option such as `serviceName` wins over conflicting `resourceAttributes['service.name']`.
    - Assert an `OTEL_RESOURCE_ATTRIBUTES` value wins over code-provided attributes for the same key.

Task 4: Add Browser config and merge logic
  MODIFY packages/logfire-browser/src/index.ts:
    - Import type `Attributes` from `@opentelemetry/api`.
    - Add `resourceAttributes?: Attributes` to `LogfireConfigOptions`.
    - Merge a resource built from `options.resourceAttributes ?? {}` into the existing browser resource.
    - Preserve existing defaults for browser attributes, service name/version, environment, and telemetry SDK attributes.
  PATTERN: packages/logfire-browser/src/index.ts:167 currently constructs the browser resource inline before passing it to `WebTracerProvider`.

Task 5: Add Browser tests
  CREATE packages/logfire-browser/src/index.test.ts:
    - Mock `WebTracerProvider` to capture constructor options.
    - Mock or no-op exporter/instrumentation classes enough to call `configure()`.
    - Stub `navigator.language` and either `navigator.userAgentData` or `navigator.userAgent`.
    - Assert a custom resource attribute is present on the captured provider resource.
    - Assert default `service.name` / `service.version` behavior is unchanged.
    - Assert `serviceName` wins over conflicting `resourceAttributes['service.name']`.

Task 6: Update docs and release metadata
  MODIFY packages/logfire-node/README.md:
    - Add a short example showing `resourceAttributes` for `service.namespace` and `service.instance.id`.
  MODIFY packages/logfire-browser/README.md:
    - Mention `resourceAttributes` for stable browser application/session resource metadata.
    - Warn against per-request or sensitive user data.
  CREATE .changeset/<descriptive-name>.md:
    - Minor bump for `@pydantic/logfire-node`.
    - Minor bump for `@pydantic/logfire-browser`.
    - Describe the new typed `resourceAttributes` configure option.
```

### Integration Points

```yaml
CONFIG:
  - packages/logfire-node/src/logfireConfig.ts — new public and resolved config fields.
  - packages/logfire-browser/src/index.ts — new public config field.

RESOURCE CONSTRUCTION:
  - packages/logfire-node/src/sdk.ts — final resource must feed traces, logs, metrics, and managed variables.
  - packages/logfire-browser/src/index.ts — final resource must feed `WebTracerProvider`.

PUBLIC API:
  - packages/logfire-node/src/index.ts — re-exports `LogfireConfigOptions` from `logfireConfig.ts`; no separate export change expected.
  - packages/logfire-browser/src/index.ts — interface is exported directly from the package entrypoint.

RELEASE:
  - .changeset/ — public option addition needs release metadata.
```

## Validation

Run focused checks first:

```bash
vp run @pydantic/logfire-node#test
vp run @pydantic/logfire-node#typecheck
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
```

Run broader checks if the implementation touches shared code or test mocks in a way that could affect packaging:

```bash
pnpm run build
pnpm run format-check
```

### Required Test Coverage

- [ ] Node happy path: custom resource attributes appear on the resource passed to `NodeSDK`.
- [ ] Node managed variables path: `configureVariables()` receives the final resource attributes including user-provided keys.
- [ ] Node precedence: first-class code config wins over conflicting `resourceAttributes`; `OTEL_RESOURCE_ATTRIBUTES` wins over code config.
- [ ] Browser happy path: custom resource attributes appear on the resource passed to `WebTracerProvider`.
- [ ] Browser default preservation: default browser and telemetry SDK attributes still exist.
- [ ] Browser precedence: `serviceName` and `serviceVersion` options win over conflicting generic resource keys.

## Unknowns & Risks

- Browser has no existing tests for `configure()`, so the first Browser test may require careful mocking of browser globals and OTel classes.
- The exact resource merge API behavior should be verified against the installed `@opentelemetry/resources` version during implementation.
- Detector support is deliberately excluded. If users need `processDetector`, `hostDetector`, or `serviceInstanceIdDetector`, add a later Node-only advanced option rather than broadening this PRP.
- If the maintainers prefer `serviceNamespace` as a first-class option, that can be added later; it should not replace the generic `resourceAttributes` escape hatch.

**Confidence: 8/10** for one-pass implementation success.
