## Goal

Bring the existing JS variable composition branch to semantic parity with the latest
Python implementation in [pydantic/logfire#1954](https://github.com/pydantic/logfire/pull/1954).

This PRP is an addendum to `plans/002-variable-composition-templates.md`, not a replacement for
the original feature plan. The current branch already implements the first pass of variable
composition and template variables. This plan covers the remaining parity gaps discovered after
reviewing Python PR #1954 at head `20f24a7`.

All work stays in the current JS SDK PR/branch. The implementation should be phased, but not
split into separate PRs.

## Why

- Python Logfire has changed the behavior beyond the original JS port: provider values now compose
  strictly, code defaults compose leniently, overrides participate in composition, and push/validate
  produces richer diagnostics.
- JS and Python should agree on the same managed-variable wire config and user-visible behavior.
- Prompt/config variables are high-leverage runtime configuration. Silent differences between SDKs
  will be hard to debug when teams use the same Logfire project from Python and JS services.
- The current JS implementation preserves some unresolved references literally. Python's latest
  behavior uses strict fallback or lenient empty rendering depending on where the value came from.

## Success Criteria

- [ ] Provider and explicit-label values compose in strict mode: unresolved `@{ref}@` or
      `@{ref.field}@` falls back to the variable's code default.
- [ ] Code defaults compose when a provider has no selected value or provider composition fails.
      Code defaults retry strict first, then non-strict when missing refs are the issue, then raw
      default if composition still cannot produce a valid value.
- [ ] Serializable context overrides run through compose -> render -> deserialize. Unserializable
      overrides return verbatim with reason `context_override`.
- [ ] Referenced variable overrides are visible through parent composition and recorded with
      `composedFrom.reason === 'context_override'`.
- [ ] `ComposedReference` has explicit `fatal` metadata. Cycles/depth are fatal; missing refs and
      malformed referenced values are soft in non-strict composition.
- [ ] `hasFatalCompositionError()` uses `fatal`, not string matching.
- [ ] Composition parsing covers Python's relevant Handlebars behavior: dotted refs, block helpers,
      helper arguments, malformed syntax reporting, escaped refs, and deep structures.
- [ ] `TemplateMismatchPolicy = 'warn' | 'error' | 'ignore'` is exposed and supported at runtime
      option level and per-template-variable level.
- [ ] `TemplateInputsMismatchError` is exposed and bypasses code-default fallback when policy is
      `error`.
- [ ] `TemplateVariable.get()` checks post-composition `{{field}}` references against
      `templateInputsSchema` according to the effective mismatch policy.
- [ ] `variablesValidate()` reports reference errors, reference cycles, and template field issues
      with enough attribution to identify root variable, found-in variable, label, and composition
      path.
- [ ] `variablesPush({ strict: false })` blocks reference cycles but allows missing refs/template
      field issues with visible warnings.
- [ ] `variablesPush()` without `strict` follows Python's default non-strict behavior and behaves
      like `{ strict: false }`.
- [ ] `variablesPush({ strict: true })` blocks missing refs, reference cycles, template field
      issues, codec incompatibilities, and label incompatibilities.
- [ ] `variablesPushTypes()` follows Python strict/non-strict behavior for existing variable labels
      that become incompatible with updated reusable type schemas.
- [ ] Template validation follows local static defaults, server labels, latest versions, server-only
      composition chains, and `LabelRef`s.
- [ ] Provider hardening matches Python where applicable: isolated config snapshots, SSE clean-close
      backoff, and variable-type network errors wrapped as `VariableWriteError`.
- [ ] Docs/examples/changelog reflect the changed semantics and new public API.
- [ ] Final validation passes:
      `vp run logfire#test -- vars`, `vp run logfire#typecheck`, and package build/type checks
      affected by public exports.

## Clarifications

### Session 2026-06-09

- Q: Should the JS implementation target exact Python parity for unresolved references, even
  where that changes current JS behavior? -> A: Yes. We are chasing accuracy; current JS behavior
  is not a priority. Provider/override values should use Python's strict fallback behavior, and
  code defaults should use Python's lenient last-resort behavior.
- Q: How should JS surface runtime warnings such as lenient code-default unresolved references or
  template mismatch policy `warn`? -> A: Use `console.warn()`. Do not add a new structured warning
  API to `ResolvedVariable` for this PRP.
- Q: Should the new validation report shape preserve old JS fields such as `referenceWarnings`
  and `templateInputWarnings` as aliases? -> A: No. This feature has not shipped in JS, so there is
  no backwards compatibility requirement. Use the clean Python-parity report shape with JS
  camelCase names.
- Q: Should `variablesPush()` return a structured validation report for non-strict warnings? ->
  A: No. Follow Python's model: `variablesPush()` keeps its small push result shape, non-strict
  warnings are surfaced with `console.warn()`, and programmatic structured diagnostics come from
  `variablesValidate()`.
- Q: How should JS handle Python's native `@{` / `}@` Handlebars delimiters when Handlebars JS
  does not support custom delimiters? -> A: Use a controlled tokenizer-based delimiter adapter,
  not a naive regex replacement. Protect runtime Handlebars delimiters such as `{{`, `}}`,
  `{{{`, `}}}`, `{{{{`, and `}}}}` as tokens, convert only real composition tags
  `@{...}@` for composition parsing, restore protected runtime delimiters after composition, and
  avoid adding the old `handlebars-delimiters` package. This parser path must be covered with many
  parity and regression tests, especially nesting, escaping, malformed syntax, helper arguments,
  and mixed runtime/composition templates.
- Q: If the tokenizer adapter plus Handlebars AST traversal cannot match a Python parity case,
  should implementation automatically move to a Handlebars fork or new dependency? -> A: No.
  Stop first and report the concrete failing parity case. Do not introduce a fork or production
  dependency without an explicit follow-up decision.
- Q: How should JS handle defaults that are functions or not JSON-serializable, including
  JS-specific cases such as `undefined`, `bigint`, and cyclic objects? -> A: Runtime `get()` should
  resolve function defaults once per call, then try to serialize the resolved value through the
  variable codec. A serialization attempt only succeeds if it returns a string. Successful
  serialized defaults compose/render/deserialize; failed serialization returns the typed default
  verbatim with reason `code_default`. Static analysis paths such as declaration-time warnings,
  `variablesValidate()`, and `variablesPush()` must not invoke function defaults and must skip
  static defaults that cannot be serialized to a string.
- Q: Should JS expose `ComposedReference.fatal` publicly or only keep it internally, and should
  `fatal` be included in the span `composed_from` attribute? -> A: Follow Python. Keep `fatal` on
  `ComposedReference` for runtime decisions and structured diagnostics, but omit `fatal` from the
  serialized span `composed_from` attribute. Span serialization should include nested
  `composed_from` but not raw referenced `value` and not `fatal`.
- Q: If a callable code default throws and there is no usable provider/override fallback, should
  JS throw to the caller or return a fallback result? -> A: Follow Python as closely as JS allows:
  do not throw. Emit `console.warn()`, return `value: undefined`, preserve the thrown exception on
  the resolved result, and use `reason: 'other_error'`.
- Q: Should JS follow Python exactly for `TemplateVariable` mismatch policy semantics? -> A: Yes.
  The default effective policy is `warn`. A per-variable `templateMismatchPolicy` overrides the
  runtime/global policy even when it relaxes behavior from `error` to `warn` or `ignore`.
  `warn` emits `console.warn()` and renders, `ignore` renders silently, and `error` throws
  `TemplateInputsMismatchError` without falling back to the code default.
- Q: What should `variablesPush()` do when the caller omits `strict`? -> A: Follow Python #1954:
  default to non-strict (`strict: false`). Omitted `strict` behaves the same as
  `{ strict: false }`: reference cycles still block, but missing refs, template field issues, and
  incompatible labels warn and apply. Explicit `{ strict: true }` blocks those issue categories.
- Q: How should unserializable context overrides behave in top-level `get()` vs nested
  composition references? -> A: Follow Python. A top-level unserializable override returns the
  override value verbatim with `reason: 'context_override'`. An unserializable override for a
  referenced variable cannot feed parent composition because there is no serialized value, so it
  emits `console.warn()` and falls through to provider/code default lookup for that referenced
  variable.
- Q: When `variablesPush()` blocks before mutation, should JS throw or return a result that records
  the block? -> A: Follow Python's non-throwing behavior. Python returns `False` for blocking
  validation gates before mutation. JS should not throw for these validation-blocking cases; it
  should return a `VariablePushResult` with `blocked: true` and a small `blockedBy` category list.
  Do not include the full validation report in the push result; structured diagnostics remain
  available through `variablesValidate()`.
- Q: Should `variablesPush({ dryRun: true, strict: true })` bypass strict/cycle blocking gates? ->
  A: No. Follow Python's order: compute and surface the diff, run validation/blocking gates, then
  handle dry-run success only if the push is not blocked. In JS, a dry-run request with a blocking
  issue returns `dryRun: true` and `blocked: true`; a dry-run request without blocking issues
  returns `dryRun: true` and `blocked: false`.
- Q: Should provider fetch/apply failures during push follow Python's `print + return False`
  behavior? -> A: No. Keep the JS API behavior: operational provider I/O and write failures should
  throw, preferably as `VariableWriteError` where applicable. Only validation/blocking gates use
  the non-throwing `{ blocked: true, blockedBy }` result.
- Q: Should `variablesPushTypes()` follow Python's strict/non-strict behavior for existing
  variable labels that become incompatible with an updated reusable type schema? -> A: Yes.
  Add `strict?: boolean` with Python's default `false`. Existing label incompatibilities warn and
  apply in non-strict mode, but block without mutation under `strict: true`. Use the same minimal
  blocked result pattern (`blocked: true`, `blockedBy`) instead of returning a full validation
  report.
- Q: What should `variablesPushTypes()` return when there are no creates or updates? -> A: Use the
  JS result shape rather than Python's CLI boolean. Return `blocked: false`, `blockedBy: []`,
  `changes: []`, and the requested `dryRun` value.
- Q: What should `variablesPush()` return when there are no changes to apply? -> A: Use the same
  JS structured result adaptation as `variablesPushTypes()`: return `blocked: false`,
  `blockedBy: []`, `changes: []`, and the requested `dryRun` value.
- Q: Should `VariablePushResult.changes` be populated when validation gates block mutation? ->
  A: Yes. When diff/change computation succeeds, keep planned changes in `changes` even if
  `blocked: true`, because Python prints the diff before applying blocking gates.
- Q: What should `VariablePushResult.blockedBy` contain? -> A: Python does not return structured
  block data; it checks gates in a fixed order and returns `False` at the first blocker. JS should
  adapt that into a minimal structured field: only the first blocking category in Python gate
  order, with no counts or details. Details remain in `variablesValidate()` and warning/error
  messages.
- Q: What should non-strict `variablesPush()` return when it applies changes with warnings? ->
  A: Follow Python's warning-and-apply behavior using the JS result shape: return `blocked: false`,
  `blockedBy: []`, planned `changes`, and the requested `dryRun`; emit warnings with
  `console.warn()`. Do not add warning details or a validation report to the push result.
- Q: For remaining edge-case details with a clear Python behavior and no JS API contradiction,
  should implementation ask again or follow Python? -> A: Follow Python #1954 directly. This
  includes `ComposedReference.fatal` defaulting to `false`, sorted unique reference extraction,
  `ValidationReport` validity semantics, exact `LabelRef` follow behavior, and span
  `composed_from` null/omission behavior.

## Context

### Key Files

- `plans/002-variable-composition-templates.md` - original variable composition PRP. Some gotchas
  are now superseded by Python #1954, especially "do not compose code defaults" and "keep
  unresolved references literal".
- `reports/python-1954-js-equivalence-plan.md` - detailed parity review and porting checklist.
- `packages/logfire-api/src/vars/index.ts` - public variable API, runtime resolution, providers,
  push/pull/validate, config normalization, remote API bodies, and public exports.
- `packages/logfire-api/src/vars/composition.ts` - current JS composition implementation.
- `packages/logfire-api/src/vars/referenceSyntax.ts` - current `@{...}@` to Handlebars conversion
  and runtime-template protection.
- `packages/logfire-api/src/vars/template.ts` - current runtime `{{...}}` rendering helpers.
- `packages/logfire-api/src/vars/templateValidation.ts` - current template path extraction and
  push-time template input validation.
- `packages/logfire-api/src/vars/composition.test.ts` - current composition tests, including the
  nested same-helper unresolved block regression.
- `packages/logfire-api/src/vars/templateValidation.test.ts` - current template validation tests.
- `packages/logfire-api/src/vars.test.ts` - broader managed-variable/provider tests.
- `packages/logfire-api/package.json` - public dependency and export surface for `logfire/vars`.
- `packages/logfire-api/vite.config.ts` - package entry/build config.
- `packages/logfire-node/src/vars.ts` - Node re-export of `logfire/vars`.
- `docs/managed-variables.md`, `packages/logfire-api/README.md`, and examples under `examples/`
  if docs/examples are updated.

### External References

- [pydantic/logfire#1954](https://github.com/pydantic/logfire/pull/1954) - source PR. Latest
  checked head: `20f24a739e51ffc151ce643763dc04e2703d5054`, updated
  `2026-06-08T21:44:07Z`.
- Python `logfire/variables/composition.py` at PR #1954 head - strict/non-strict expansion,
  `ComposedReference.fatal`, missing-ref soft errors, cycle/depth fatal errors, dependency
  extraction and rendering.
- Python `logfire/variables/_handlebars.py` - native `@{` / `}@` Handlebars environment, strict
  option, compile/dependency caches, compatibility checker.
- Python `logfire/variables/template_validation.py` - `TemplateFieldIssue`, composition-aware
  template validation, cycle detection, template string extraction.
- Python `logfire/variables/variable.py` - runtime resolution pipeline, context override
  composition, code-default composition, callable-default caching, template mismatch policy.
- Python `logfire/variables/abstract.py` - validation report shape, reference graph checking,
  push strict/non-strict behavior, template field issue formatting.
- Python `logfire/variables/remote.py` - remote provider hardening and read-after-write refresh.
- Python tests:
  `tests/test_variable_composition.py`, `tests/test_variable_templates.py`,
  `tests/test_template_validation.py`, and `tests/test_push_variables.py`.

### Gotchas

- This PRP intentionally supersedes parts of `002`:
  - Code defaults must now compose.
  - Unresolved refs should not always stay literal.
  - Template schema validation is no longer only push-time if the variable is a
    `TemplateVariable`; runtime mismatch policy applies during `get(inputs)`.
- Python uses `pydantic-handlebars` with native custom delimiters. JS currently simulates custom
  delimiters by protecting `{{...}}` and converting `@{...}@` to `{{...}}`. Parser parity is the
  highest-risk implementation detail.
- Handlebars JS documents that alternative delimiters are unsupported. Do not depend on
  `handlebars-delimiters`: it is old, replacement-based, and does not solve the parser problem
  better than a focused local adapter with tests.
- Handlebars JS strict mode and Python `pydantic-handlebars` strict mode may not match perfectly.
  The acceptance tests should pin behavior rather than trusting library defaults.
- JS warning behavior has no exact Python `RuntimeWarning` equivalent. Per clarification, use
  `console.warn()` and cover warning paths with spies in tests.
- Existing JS report fields use warning-oriented names: `referenceWarnings` and
  `templateInputWarnings`. This feature has not shipped in JS, so replace them with the clean
  Python-parity shape using JS camelCase names.
- Do not introduce unrelated module splits. `002` suggested a broad split; the branch already has
  focused files for composition/template behavior. Keep refactoring limited to what parity needs.
- Browser and Cloudflare Workers compatibility matters. Avoid Node-only APIs in `logfire/vars`.
- `reports/` currently contains untracked planning/review artifacts. Do not assume reports are
  committed unless the user asks.

## Implementation Assumptions

- New canonical report fields should use JS camelCase names:
  `referenceErrors`, `referenceCycles`, `templateFieldIssues`.
- If the tokenizer-based delimiter adapter and Handlebars AST traversal cannot match a Python
  parity case, pause with the failing case before adding a production dependency or forking
  Handlebars.
- JS serialization should treat only a returned string as a successful serialized value. For
  example, `JSON.stringify(undefined)` returns `undefined`, so it must be treated like failed
  serialization and skipped for static analysis / returned raw at runtime.

## Implementation Blueprint

### Data Models

Add or update these public/runtime types:

```ts
export type TemplateMismatchPolicy = 'warn' | 'error' | 'ignore'

export class TemplateInputsMismatchError extends Error {}

export interface ComposedReference {
  composedFrom?: ComposedReference[]
  error?: string
  fatal: boolean
  label?: string
  name: string
  reason: VariableResolutionReason
  value?: string
  version?: number
}

export interface ExpandReferencesOptions {
  rootName?: string
  strict?: boolean
}

export interface TemplateFieldIssue {
  fieldName: string
  foundInLabel?: string
  foundInVariable: string
  message: string
  referencePath: string[]
  rootVariable: string
}

export interface ValidationReport {
  // Existing fields preserved.
  errors: LabelValidationError[]
  variablesChecked: number
  variablesNotOnServer: string[]
  descriptionDifferences: DescriptionDifference[]
  isValid: boolean

  // New canonical parity fields.
  referenceErrors: string[]
  referenceCycles: string[]
  templateFieldIssues: TemplateFieldIssue[]
}

export type VariablePushBlockReason =
  | 'reference_cycles'
  | 'reference_errors'
  | 'template_field_issues'
  | 'incompatible_labels'
  | 'incompatible_type_labels'

export interface VariablePushResult {
  blocked: boolean
  blockedBy: VariablePushBlockReason[]
  changes: VariablePushChange[]
  dryRun: boolean
}
```

Extend options:

```ts
export interface VariablesOptions {
  templateMismatchPolicy?: TemplateMismatchPolicy
}

export interface LocalVariablesOptions {
  templateMismatchPolicy?: TemplateMismatchPolicy
}

export type TemplateVariableOptions<T, InputsT extends Record<string, unknown>> =
  InputsT extends Record<string, unknown> ? VariableOptions<T> & { templateMismatchPolicy?: TemplateMismatchPolicy } : never
```

### Tasks

Execution order:

- Start with `Task 8` as an isolated Phase 0 parser/tokenizer gate before the runtime, push, and
  provider work. This stays in the same PR/branch, but should be implemented and reviewed as a
  self-contained slice: tokenizer adapter, AST dependency extraction, parser diagnostics, and
  parser-focused tests only.
- Stop before broader PRP execution if Phase 0 cannot match a Python parser parity case without a
  fork or new production dependency.
- Phase 0 validation target: `vp run logfire#test -- vars -t "reference|composition|template"`,
  or the nearest package test filter that runs only parser/composition tests.

```yaml
Task 1: Pin parity tests for runtime composition
  MODIFY/CREATE packages/logfire-api/src/vars/*.test.ts:
    - Add failing tests for provider missing-ref fallback to code default.
    - Add failing tests for code-default composition and lenient missing-ref rendering.
    - Add failing tests for context override composition and referenced override propagation.
    - Add tests for callable default invoked once per get() across fallback paths.
    - Add tests for `ComposedReference.fatal` on cycle/depth and `fatal: false` or omitted on soft errors.
  PATTERN:
    - Mirror Python tests:
      `test_nonexistent_reference_in_provider_value_falls_back_to_code_default`,
      `test_code_default_composition_when_provider_has_no_value`,
      `test_code_default_with_unresolved_reference_renders_empty`,
      `test_override_participates_in_composition`,
      `test_override_propagates_through_composition`.

Task 2: Add strict/non-strict composition mode
  MODIFY packages/logfire-api/src/vars/composition.ts:
    - Add `strict?: boolean` to options.
    - In strict mode, unresolved refs should fail composition instead of being preserved.
    - In non-strict mode, unresolved refs should render with Handlebars empty/falsy semantics.
    - Add explicit `fatal` metadata and stop inferring fatal errors by string matching.
    - Set `fatal: false` on normal/soft references and `fatal: true` only for cycle/depth errors,
      matching Python's dataclass default.
    - Ensure invalid referenced JSON records a soft error in non-strict mode.
    - Ensure cycle/depth metadata is fatal.
  MODIFY packages/logfire-api/src/vars/referenceSyntax.ts:
    - If needed, add strict rendering support or hooks to detect unresolved paths before rendering.
  PATTERN:
    - Python `expand_references(..., strict=True|False)`.
    - Python `ComposedReference.fatal` docstring.

Task 3: Refactor resolution around shared serialized attempts
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Introduce an internal attempt helper for compose -> optional render -> deserialize.
    - Introduce a shared lookup helper for references:
      context override -> provider/label -> registered code default.
    - Provider and explicit-label values call the attempt helper with strict composition.
    - If provider/label attempt fails, resolve the variable's own code default.
    - Code default resolution resolves function defaults once per `get()`, serializes through the
      codec, composes strict first, then non-strict on missing refs, then raw fallback.
    - Treat serialization as successful only when it returns a string. Throwing, returning
      `undefined`, or returning another non-string value means the typed default is returned
      verbatim with reason `code_default`.
    - Preserve label/version/exception/reason metadata as Python does where applicable.
  PATTERN:
    - Python `_lookup_serialized`, `_try_resolve`, `_resolve_code_default_value`,
      `_ResolveAttempt`.

Task 4: Compose context overrides
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Top-level override first resolves function values if needed.
    - Try to serialize through the variable codec.
    - If serialization succeeds, run strict compose -> render -> deserialize.
    - If serialization fails, return override value verbatim with reason `context_override`.
    - Referenced variable overrides must be visible to parent composition when serializable.
    - Referenced variable overrides that cannot serialize must emit `console.warn()` and fall
      through to provider/code default lookup instead of returning a raw object into parent
      composition.
  PATTERN:
    - Python `_resolve_context_override`.
    - Python `_lookup_serialized`.

Task 5: Add per-get callable default cache
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Cache default function results and default function exceptions inside one `get()` call.
    - Ensure validation/composition fallback paths do not invoke the same default twice.
    - Do not use this cache for static analysis paths: declaration-time warnings,
      `variablesValidate()`, and `variablesPush()` must not invoke function defaults.
    - If a default function raises and there is no usable provider/override fallback, emit
      `console.warn()`, return `value: undefined`, preserve the thrown exception, and use
      `reason: 'other_error'`.
  PATTERN:
    - Python `_DEFAULT_CACHE`, `_get_default_cached`.

Task 6: Add template mismatch policy
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Export `TemplateMismatchPolicy` and `TemplateInputsMismatchError`.
    - Store runtime-level `templateMismatchPolicy` in `runtimeState`.
    - Store per-variable `templateMismatchPolicy` on `TemplateVariable`.
    - Resolve effective policy: variable override -> runtime/global options -> `warn`.
    - Per-variable policy wins even when it relaxes a stricter runtime/global policy, matching
      Python.
  MODIFY packages/logfire-api/src/vars/templateValidation.ts:
    - Reuse or add `extractTemplateStrings()` and path compatibility checking.
    - Return error-severity paths that are not declared by `templateInputsSchema`.
  MODIFY TemplateVariable.get():
    - After composition and before runtime render, check post-composition serialized value.
    - `warn`: emit warning and render anyway.
    - `error`: throw `TemplateInputsMismatchError` without default fallback and without converting
      the failure into a `ResolvedVariable`.
    - `ignore`: render silently.
  PATTERN:
    - Python `TemplateVariable._effective_template_mismatch_policy`.
    - Python `TemplateVariable._check_template_fields`.

Task 7: Add declaration-time template composition warning
  MODIFY packages/logfire-api/src/vars/index.ts:
    - When registering a plain variable with static serializable default, warn if it composes an
      already registered template variable.
    - When registering a template variable, warn if an already registered plain variable's static
      default composes it.
    - Skip function defaults and unserializable defaults.
  PATTERN:
    - Python `warn_on_template_inputs_composition_mismatch`.

Task 8: Add parser/dependency extraction parity (execute first as Phase 0)
  MODIFY packages/logfire-api/src/vars/referenceSyntax.ts and composition helpers:
    - Add `findReferencesAndErrors(serializedValue)`.
    - Replace broad string replacement with a tokenizer-based delimiter adapter:
      - scan string leaves left-to-right;
      - protect runtime Handlebars delimiter tokens (`{{`, `}}`, triple, and quad forms);
      - convert only composition tags `@{...}@` into temporary Handlebars tags for parsing;
      - preserve escaped composition starts such as `\@{`;
      - restore protected runtime delimiters after composition render.
    - Use Handlebars AST extraction on the adapted composition-only template.
    - Do not add `handlebars-delimiters`; it is replacement-based and stale.
    - Cover helper arguments such as `@{lookup obj key}@`.
    - Cover dotted block headers such as `@{#if user.active}@`.
    - `findReferences()` and `findReferencesAndErrors()` return sorted unique top-level variable
      names, matching Python.
    - Malformed templates should produce parse errors for validation and should not crash
      `findReferences()`.
    - Deep structures should be walked iteratively or with an explicit stack where needed.
  PATTERN:
    - Python `_walk_references`, `find_references_and_errors`,
      `_handlebars.extract_composition_dependencies`.

Task 9: Add graph-wide reference validation
  MODIFY packages/logfire-api/src/vars/index.ts and/or templateValidation.ts:
    - Walk from every local variable.
    - Include local static code defaults.
    - Include server `LabeledValue` labels and `latest_version`.
    - Transitively follow refs into server-only variables.
    - Report missing refs reached through server-only chains.
    - Detect cycles including cycles with server-only midpoints.
    - Convert too-deep/recursive graphs into a clean blocking reference error.
  PATTERN:
    - Python `_check_reference_errors`.

Task 10: Add TemplateFieldIssue validation
  MODIFY packages/logfire-api/src/vars/templateValidation.ts:
    - Add `TemplateFieldIssue`.
    - Add composition-aware validation from each local `TemplateVariable` root.
    - Validate local static defaults, server labels, latest version, and followed `LabelRef`s.
    - Record `rootVariable`, `foundInVariable`, `foundInLabel`, and `referencePath`.
    - Deduplicate within one root only; do not dedupe the same shared bad fragment across roots.
    - Skip function defaults and unserializable defaults.
  PATTERN:
    - Python `TemplateFieldIssue`.
    - Python `validate_template_composition`.
    - Python `_collect_template_field_issues`.

Task 11: Update variablesValidate and variablesPush behavior
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Add `referenceErrors`, `referenceCycles`, and `templateFieldIssues` to validation reports.
    - Remove/replace `referenceWarnings` and `templateInputWarnings`; the feature has not shipped,
      so no compatibility aliases are required.
    - Make `referenceErrors` include both missing/malformed refs and cycles; `referenceCycles` is
      the cycle subset, matching Python.
    - Make `isValid` false when `errors`, `variablesNotOnServer`, `referenceErrors`, or
      `templateFieldIssues` are non-empty. Description differences do not make the report invalid.
    - In push:
      - default omitted `strict` to `false`, matching Python.
      - cycles block always.
      - missing refs, template field issues, and incompatible labels block in strict mode.
      - missing refs, template field issues, and incompatible labels warn and apply in non-strict
        mode.
      - non-strict mode emits `console.warn()` warnings, while structured diagnostics remain
        available through `variablesValidate()`.
      - non-strict warning-and-apply cases return `{ blocked: false, blockedBy: [], changes,
        dryRun }`.
      - validation-blocking cases return `{ blocked: true, blockedBy, changes, dryRun }` without
        mutating the provider, matching Python's `False` return instead of throwing. Keep planned
        changes populated when change computation succeeds.
      - populate `blockedBy` with only the first blocking category in Python gate order:
        `reference_cycles`, `reference_errors`, `template_field_issues`, `incompatible_labels`.
        Do not include later blocker categories, counts, or details in `blockedBy`.
      - `dryRun` does not bypass blocking gates. Run validation/blocking checks before treating
        dry-run as successful.
      - no-op pushes return `{ blocked: false, blockedBy: [], changes: [], dryRun }`.
      - provider fetch/apply failures remain thrown operational errors in JS; do not convert them
        to `blocked: true`.
      - strict mode error messages distinguish issue categories.
  PATTERN:
    - Python `ValidationReport`.
    - Python `VariableProvider.push_variables`.

Task 12: Harden LabelRef validation
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Audit runtime `resolveSerializedValueForLabel` / label ref following against Python.
    - Add tests for latest refs, code_default refs, label-to-label chains, ref cycles, and missing labels.
    - Follow Python exactly:
      - `LabelRef('code_default')` resolves to no serialized value and triggers code-default
        fallthrough.
      - `LabelRef('latest')` resolves to `latest_version` when present; when absent it resolves to
        no serialized value while preserving the ref's version metadata where applicable.
      - label-to-label chains follow transitively.
      - label-ref cycles and missing target labels resolve to no serialized value instead of
        throwing.
    - Ensure template field validation follows refs and reports against the serving label.
    - Keep codec validation from directly parsing ref-only labels unless they resolve to a value.
  PATTERN:
    - Python `VariableConfig.follow_ref`.
    - Python `get_all_serialized_values()` inside `_collect_template_field_issues`.

Task 13: Harden remote/local providers
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Return isolated snapshots from local and remote `getAllVariablesConfig()`.
    - Reset SSE reconnect delay only after valid event data is received, not immediately after a
      successful HTTP response.
    - Back off after clean stream end.
    - Wrap `listVariableTypes()` network failures as `VariableWriteError`.
  PATTERN:
    - Python `LogfireRemoteVariableProvider.refresh`, `_sse_listener`,
      `get_all_variables_config`, and variable type tests.

Task 14: Add variablesPushTypes strict/non-strict parity
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Add `strict?: boolean` to `variablesPushTypes()` options, defaulting to `false`.
    - For updated reusable type schemas, inspect existing variables whose `type_name` uses the
      updated type.
    - Validate their existing labels and latest versions against the new type schema.
    - In non-strict mode, emit `console.warn()` for incompatible existing labels and still apply
      type updates.
    - In strict mode, return `{ blocked: true, blockedBy: ['incompatible_type_labels'], changes,
      dryRun }` without mutating type schemas.
    - If there are no creates or updates, return `{ blocked: false, blockedBy: [], changes: [],
      dryRun }`.
    - Preserve JS operational behavior: list/upsert provider failures throw, preferably
      `VariableWriteError`; do not convert them to `blocked: true`.
    - If compatibility checking itself cannot fetch current variable config, warn and continue,
      matching Python.
  PATTERN:
    - Python `VariableProvider.push_variable_types`.
    - Python `_check_type_label_compatibility`.

Task 15: Update span serialization
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Ensure span `composed_from` attribute includes nested `composed_from`.
    - Omit raw referenced `value` from span attributes.
    - Omit `fatal` from span attributes. Keep `fatal` on runtime `ComposedReference` only, matching
      Python's decision-vs-observability split.
    - Include Python-style `null` values for absent `version`, `label`, and `error` in serialized
      span `composed_from`; omit `composed_from` when there are no nested references.
  PATTERN:
    - Python `_serialize_composed_reference`.

Task 16: Update docs, examples, and release metadata
  MODIFY docs/managed-variables.md and/or package README:
    - Document strict provider behavior and lenient code-default behavior.
    - Document override composition.
    - Document `templateMismatchPolicy`.
    - Document strict/non-strict push behavior and report issue fields.
  MODIFY examples if useful:
    - Add an example with composed prompt fragments and template inputs.
  CREATE .changeset if package-visible changes are shipping in this branch.
```

### Integration Points

```yaml
PUBLIC API:
  - `logfire/vars` exports `TemplateMismatchPolicy` and `TemplateInputsMismatchError`.
  - `defineTemplateVar` / `templateVar` accept `templateMismatchPolicy`.
  - `configureVariables` accepts runtime-level `templateMismatchPolicy`.
  - Existing public exports remain stable.

RUNTIME:
  - `Variable.get()` uses strict composition for provider/label values.
  - `Variable.get()` composes code defaults as the fallback path.
  - `Variable.override()` can feed the composition pipeline when the override is serializable.
  - `TemplateVariable.get()` composes first, checks mismatch policy, renders, then parses.

VALIDATION:
  - `variablesValidate()` produces graph-wide reference/template diagnostics.
  - `variablesPush()` enforces strict/non-strict behavior while keeping one PR branch.

PROVIDER:
  - Local/remote providers expose snapshot configs.
  - Remote SSE and variable-type APIs match Python hardening.

OBSERVABILITY:
  - Resolution spans keep current attributes and use Python-compatible `composed_from` nesting.
```

## Validation

Run after each major phase:

```bash
vp run logfire#test -- vars
vp run logfire#typecheck
```

Run after public API/docs/dependency changes:

```bash
vp run @pydantic/logfire-node#typecheck
pnpm run build
pnpm run format-check
```

If docs/examples are updated, run relevant example scripts when available.

### Required Test Coverage

- [ ] Provider value `main = "Hello @{missing}@"` falls back to `main` code default.
- [ ] Code default `main.default = "Hello @{missing}@"` resolves to `"Hello "` with warning.
- [ ] Code default `main.default = "Hello @{greeting}@"` composes registered/provider `greeting`.
- [ ] Callable default is invoked once across composition failure and fallback paths.
- [ ] Runtime callable default returning `"Hello @{greeting}@"` composes after one invocation.
- [ ] Failing callable default with no usable provider/override fallback does not throw; it warns,
      returns `value: undefined`, preserves the exception, and uses `reason: 'other_error'`.
- [ ] Validation and push do not invoke callable defaults.
- [ ] Static default `undefined` is treated as failed serialization, not serialized JSON.
- [ ] Static default `bigint` and cyclic object defaults do not crash validation/push and return
      raw/verbatim at runtime when used as code default.
- [ ] Serializable override `"Hi @{greeting}@!"` resolves to `"Hi Hello!"`.
- [ ] Referenced variable override changes parent composition and records `context_override`.
- [ ] Unserializable override returns verbatim.
- [ ] Top-level unserializable override returns verbatim with `reason: 'context_override'`.
- [ ] Referenced unserializable override warns and falls through to provider/code default for
      parent composition.
- [ ] Cycle and depth errors set `fatal: true`.
- [ ] Normal and soft-error `ComposedReference` entries set `fatal: false`.
- [ ] `fatal` is available on runtime `ComposedReference` but omitted from serialized span
      `composed_from`, matching Python.
- [ ] Missing refs and malformed referenced JSON are soft in non-strict composition.
- [ ] Dotted refs, block helpers, helper args, escaped refs, malformed syntax, and deep structures
      match Python tests.
- [ ] Reference extraction returns sorted unique top-level variable names.
- [ ] The delimiter adapter is heavily covered:
      runtime `{{...}}` fields remain runtime-only, `@{...}@` refs inside runtime blocks compose,
      triple/quad runtime delimiters are preserved, escaped `\@{` stays literal, mixed
      runtime/composition nesting is stable, malformed composition delimiters report diagnostics
      without crashing, and user text cannot collide with internal sentinels.
- [ ] `TemplateMismatchPolicy` default `warn` warns and renders.
- [ ] `TemplateMismatchPolicy` `error` throws `TemplateInputsMismatchError`.
- [ ] `TemplateMismatchPolicy` `ignore` renders silently.
- [ ] Per-variable mismatch policy overrides runtime policy, including relaxations.
- [ ] Per-variable `ignore` or `warn` relaxes runtime/global `error`.
- [ ] `TemplateInputsMismatchError` is not swallowed by code-default fallback or converted into a
      resolved result.
- [ ] Plain var composing template var emits declaration-time warning.
- [ ] `variablesValidate()` reports missing refs through server-only chains.
- [ ] `variablesValidate()` reports cycles through server-only chains.
- [ ] `ValidationReport.referenceErrors` includes cycles, `referenceCycles` is the cycle subset,
      and `isValid` ignores description differences while failing on errors, missing server vars,
      reference errors, and template field issues.
- [ ] `TemplateFieldIssue` identifies root, found-in variable, found-in label, field, and path.
- [ ] Template field issues are reported once per affected root, not globally deduped away.
- [ ] `LabelRef` latest/code_default/label-chain/cycle behavior is covered.
- [ ] `LabelRef('code_default')`, missing `latest`, label-to-label chains, missing label targets,
      and label-ref cycles follow Python's no-throw/no-serialized-value behavior.
- [ ] Push with omitted `strict` behaves like `strict: false`.
- [ ] Validation-blocked push does not mutate the provider and returns `blocked: true` with
      `blockedBy`, not a thrown error.
- [ ] Validation-blocked push retains planned `changes` when diff computation succeeds.
- [ ] `blockedBy` contains only the first blocking category in Python gate order and no
      counts/details.
- [ ] `variablesPush({ dryRun: true, strict: true })` with a blocking issue returns
      `dryRun: true`, `blocked: true`, and does not mutate the provider.
- [ ] `variablesPush({ dryRun: true })` without blocking issues returns `dryRun: true`,
      `blocked: false`, reports changes, and does not mutate the provider.
- [ ] `variablesPush()` no-op returns `blocked: false`, `blockedBy: []`, `changes: []`, and the
      requested `dryRun`.
- [ ] Non-strict warning-and-apply push returns `blocked: false`, `blockedBy: []`, planned
      `changes`, and emits `console.warn()` without embedding warning details in the result.
- [ ] Provider fetch/apply failures during push throw operational errors rather than returning
      `blocked: true`.
- [ ] Non-strict push blocks cycles but allows missing refs/template field issues with visible warnings.
- [ ] Strict push blocks missing refs/template field issues.
- [ ] `variablesPushTypes()` default omitted `strict` behaves like `strict: false`.
- [ ] `variablesPushTypes({ strict: false })` warns and applies type updates when existing labels
      are incompatible with the updated type schema.
- [ ] `variablesPushTypes({ strict: true })` returns `blocked: true` with
      `blockedBy: ['incompatible_type_labels']` and does not mutate type schemas.
- [ ] `variablesPushTypes({ dryRun: true, strict: true })` follows Python ordering: blocking
      incompatible type labels return `dryRun: true`, `blocked: true`, and do not mutate.
- [ ] `variablesPushTypes()` no-op returns `blocked: false`, `blockedBy: []`, `changes: []`, and
      the requested `dryRun`.
- [ ] Local/remote `getAllVariablesConfig()` snapshots cannot mutate provider state.
- [ ] SSE clean close backs off; variable-type list network errors wrap in `VariableWriteError`.
- [ ] Spans include nested `composed_from` without raw referenced values or `fatal`, use `null`
      for absent `version`/`label`/`error`, and omit empty nested `composed_from`.

## Unknowns & Risks

- Runtime warnings intentionally use `console.warn()`. Tests should spy on `console.warn()` where
  warning behavior matters, and implementation should avoid duplicate warnings for one resolution
  attempt.
- Changing unresolved references from "literal preservation" to Python's strict/lenient behavior is
  a real behavior change in this branch. This is intentional per clarification; tests must pin the
  Python-compatible behavior.
- `ValidationReport` should use the clean new shape. Existing branch-local tests using
  `referenceWarnings` or `templateInputWarnings` must be migrated.
- Handlebars JS may not expose exactly the same dependency extraction semantics as
  `pydantic-handlebars`; helper args and malformed templates may need custom AST traversal. The
  tokenizer adapter is accepted only if parity tests cover the mixed-delimiter cases above.
- Code-default serialization through JS codecs may not map perfectly to Python Pydantic
  `dump_json`. Tests need to pin JS-specific edge cases such as `undefined`, `bigint`, cyclic
  objects, and function defaults. Serialization success means "returned a string", not merely
  "did not throw".
- `TemplateVariable.get()` currently renders after `super.get()`; the new `error` policy must bypass
  fallback paths cleanly.
- `variablesPush()` intentionally does not return a validation report. Tests should use
  `variablesValidate()` for structured diagnostics and spy on `console.warn()` for non-strict push
  warning behavior.
- Provider snapshot cloning must preserve normalized config semantics without accidentally dropping
  undefined/null distinctions expected by existing tests.

**Confidence: 8/10** after clarification. The API choices around warnings, report compatibility,
push result shape, and parser strategy are resolved. The remaining risk is implementation
equivalence in the tokenizer/Handlebars adapter, JS serialization edge cases, and provider
hardening tests.
