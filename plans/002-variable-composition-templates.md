## Goal

Port the managed-variable composition/reference feature from [pydantic/logfire#1731](https://github.com/pydantic/logfire/pull/1731) into `logfire-js`.

The JS SDK should support remote/local variable values that reference other managed variables with `@{variable_name}@` syntax, preserve runtime `{{placeholder}}` templates during composition, and provide a typed convenience API for rendering Handlebars templates with runtime inputs.

This PRP is scoped to the runtime-agnostic `logfire/vars` implementation plus Node re-export docs/examples. Browser-specific remote credential handling remains out of scope; browser users can still use local variable configs through `logfire/vars`.

## Why

- Prompt and AI configuration variables often need reusable fragments such as safety rules, brand voice, output schema guidance, and per-environment copy.
- Python Logfire is adding composition and template rendering in PR 1731. JS should stay wire-compatible with the same variable config shape and syntax.
- Composition lets the Logfire UI update shared fragments without redeploying every app that consumes a composed variable.
- Template rendering gives JS users the same one-step "resolve, compose, render, parse" workflow for prompt variables that Python users get from `template_var()`.

## Success Criteria

- [ ] `@{var}@` references in JSON-serialized variable string values are expanded before `codec.parse()` runs.
- [ ] References support dotted access such as `@{brand.tagline}@` and block helpers such as `@{#if beta}@...@{else}@...@{/if}@`.
- [ ] Escaped references written as `\@{name}@` are preserved as literal `@{name}@`.
- [ ] Runtime `{{placeholder}}` templates are preserved during `@{}@` composition.
- [ ] Composition handles nested references, missing references, invalid referenced JSON, circular references, and depth limits deterministically.
- [ ] `ResolvedVariable` exposes composition metadata and records it on variable resolution spans.
- [ ] `ResolvedVariable.render(inputs)` renders `{{}}` templates in the post-composition serialized value and reparses through the variable codec.
- [ ] A JS-style `defineTemplateVar<T, InputsT>()` API, plus `templateVar` alias, resolves, composes, renders, and parses in one `get(inputs, options?)` call.
- [ ] `VariableConfig` supports `template_inputs_schema` and syncs it through build, normalize, validate, push, pull, and remote write bodies.
- [ ] Validation reports reference warnings, composition cycles, and common Handlebars template paths that are incompatible with `template_inputs_schema`.
- [ ] `handlebars` is a direct `logfire` dependency but remains isolated to the `logfire/vars` entrypoint.
- [ ] Docs, examples, tests, and a changeset cover the public API addition.

## Clarifications

### Session 2026-05-08

- Q: Which public API shape should the PRP lock in for template variables? -> A: Use JS-style `defineTemplateVar()` plus `templateVar` alias, matching existing `defineVar()` conventions.
- Q: How strict should first-pass template input validation be? -> A: Use pragmatic Handlebars AST parsing plus JSON Schema property/path checks, and document unsupported edge cases instead of requiring full Python parity in the first pass.
- Q: How should the Handlebars runtime be introduced? -> A: Add `handlebars` as a direct `logfire` dependency and keep it isolated to the `logfire/vars` entrypoint.
- Q: Should `templateVar.get(inputs)` validate `inputs` against `templateInputsSchema` at runtime? -> A: No. `templateInputsSchema` is consulted only by `variablesValidate()` and strict push; `get(inputs)` trusts the caller and avoids pulling a JSON Schema validator (e.g., `ajv`) into the `vars` entry.
- Q: How should composition and render errors be exposed? -> A: Introduce new typed error classes mirroring the existing `VariableWriteError` family - `VariableCompositionError`, `VariableCompositionCycleError`, `VariableCompositionDepthError`, and `VariableRenderError` - so consumers can handle them via `instanceof`.
- Q: How should the `vars` module and tests be organized? -> A: Split `src/vars/index.ts` now into focused modules (`composition.ts`, `referenceSyntax.ts`, `template.ts`, `templateValidation.ts`), keep `index.ts` as the public barrel, and split tests to match (`composition.test.ts`, `template.test.ts`, `templateValidation.test.ts`); existing `vars.test.ts` may stay as the home for legacy behavior or be migrated alongside.
- Q: What should the `InputsT` generic for `defineTemplateVar<T, InputsT>` look like? -> A: `InputsT extends Record<string, unknown> = Record<string, unknown>` - object-shaped inputs only, matching Handlebars' top-level context model.

## Context

### Key Files

- `packages/logfire-api/src/vars/index.ts` - all current managed-variable types, providers, resolution, sync, validation, and public exports live in one file.
- `packages/logfire-api/src/vars.test.ts` - current managed-variable behavior tests. New tests can either extend this file or split into focused `src/vars/*.test.ts` files if the implementation is split.
- `packages/logfire-api/vite.config.ts` - package entries include `vars`; add any new runtime dependency to pack dependency handling if needed.
- `packages/logfire-api/package.json` - add `handlebars` if the port uses the standard JS Handlebars runtime.
- `packages/logfire-node/src/vars.ts` - re-exports `logfire/vars`; no separate implementation expected.
- `docs/managed-variables.md` - main managed-variable docs for JS users.
- `packages/logfire-api/README.md` - package README includes a short managed-variable section.
- `examples/node/variables.ts` - existing runnable managed-variable example; can be extended or paired with a new composition example.
- `.changeset/` - public API and dependency changes need release metadata.

### External References

- [pydantic/logfire#1731](https://github.com/pydantic/logfire/pull/1731) - source feature and intended Python behavior.
- [Python composition.py](https://raw.githubusercontent.com/pydantic/logfire/10d2d5207dc8f885cff15f052766693789498d7c/logfire/variables/composition.py) - reference expansion, reference discovery, cycle/depth handling, and metadata shape.
- [Python reference_syntax.py](https://raw.githubusercontent.com/pydantic/logfire/10d2d5207dc8f885cff15f052766693789498d7c/logfire/variables/reference_syntax.py) - conversion of `@{}@` tags to Handlebars while protecting `{{}}`.
- [Python variable.py](https://raw.githubusercontent.com/pydantic/logfire/10d2d5207dc8f885cff15f052766693789498d7c/logfire/variables/variable.py) - resolution pipeline and `TemplateVariable` behavior.
- [Python abstract.py](https://raw.githubusercontent.com/pydantic/logfire/10d2d5207dc8f885cff15f052766693789498d7c/logfire/variables/abstract.py) - `ResolvedVariable.render()`, sync diff behavior, and validation report extensions.
- [Python tests](https://github.com/pydantic/logfire/pull/1731/files) - use `test_variable_composition.py`, `test_variable_templates.py`, and `test_template_validation.py` as behavior checklists.
- [Handlebars compile API](https://handlebarsjs.com/api-reference/compilation.html) - `Handlebars.compile(template, { noEscape: true })` avoids HTML escaping prompt/config values.
- [Handlebars built-in helpers](https://handlebarsjs.com/guide/builtin-helpers.html) - expected semantics for `if`, `unless`, `each`, `with`, and `else`.
- [handlebars npm package](https://www.npmjs.com/package/handlebars) - latest checked version was `4.7.9`; the package ships its own TypeScript declarations.

### Gotchas

- JS cannot infer a JSON Schema from a TypeScript `InputsT` generic at runtime. Use an explicit `templateInputsSchema?: JsonSchema` option for JS, even though Python derives the schema from a Pydantic model.
- Current JS variable resolution is async because providers can fetch remotely. Composition helpers must be async when they call `provider.getSerializedValue()`.
- Do not compose code defaults. Python PR 1731 explicitly returns code defaults containing `@{...}@` as-is when no serialized provider value exists. Template defaults for `defineTemplateVar()` should still render `{{}}` inputs.
- Render templates against decoded JSON values, then re-encode. Rendering raw JSON strings can break JSON when inputs contain quotes, backslashes, or newlines.
- Use `noEscape: true` or equivalent safe values. Handlebars defaults to HTML escaping, which is wrong for prompt/config templates.
- Keep unresolved references literal, for example `@{missing}@`, while still recording a `ComposedReference` entry with an unresolved reason.
- `handlebars` should be a direct `logfire` dependency, but avoid introducing it into the main tracing entry. Verify bundle output after implementation.
- Existing `VariableOptions<T>.codec` is the only runtime type validator. `defineTemplateVar()` should reuse that codec rather than adding a second parsing path.
- First-pass template validation is intentionally pragmatic: parse Handlebars AST paths and validate them against JSON Schema object properties, but document unsupported helpers/schema constructs instead of blocking on full Python parity.
- Reuse the existing `JsonSchema` export at `packages/logfire-api/src/vars/index.ts:6` (`type JsonSchema = Record<string, unknown>`); do not redeclare it.
- `MAX_COMPOSITION_DEPTH = 20` (Python `composition.py:46`).
- Pin `handlebars` by querying `pnpm info handlebars version` at install time rather than hard-coding 4.7.x; do not rely on the version mentioned in this PRP.
- `templateVar.get(inputs)` does NOT validate `inputs` against `templateInputsSchema` at runtime. Schema validation only fires through `variablesValidate()` and strict push, mirroring the JS-side decision to keep the `vars` entry free of an `ajv`-style validator dependency.
- HTML escaping: use per-leaf `Handlebars.SafeString` wrapping (matches Python `_protect_value`), NOT `noEscape: true`. Per-leaf wrapping disables escaping only for trusted context values, not for anything the template author might inject.
- Block-helper references: `@{#if foo}@...@{/if}@` collects `foo` (not `if`) as the resolvable name. The `#if`/`#each`/`#unless`/`#with` keywords are Handlebars built-ins; only the _condition/iterable identifier_ needs resolving. Filter `else` and `this` out of collected refs as well.
- The `_REFERENCE_TAG` regex (used for substitution) and `_SIMPLE_REF`/`_BLOCK_REF` (used for collection) are NOT redundant. The substitution regex is permissive (matches anything between `@{` and `}@` lazily) because Handlebars itself parses the resulting `{{...}}`; the collection regexes are strict because we use them to drive resolution.

## Implementation Blueprint

### Data Models

Add composition metadata and render state:

```ts
export interface ComposedReference {
  composedFrom?: ComposedReference[]
  error?: string
  label?: string
  name: string
  reason: VariableResolutionReason
  value?: string
  version?: number
}

export interface ResolvedVariableInit<T> {
  composedFrom?: ComposedReference[]
  deserializer?: (serialized: string) => T
  exception?: unknown
  label?: string
  name: string
  reason: VariableResolutionReason
  serializedValue?: string
  value: T
  version?: number
}
```

Extend variable config and options. Reuse the existing `JsonSchema` export at `packages/logfire-api/src/vars/index.ts:6` (`type JsonSchema = Record<string, unknown>`); do not redeclare it:

```ts
export interface VariableConfig {
  template_inputs_schema?: JsonSchema | null
}

export interface VariableOptions<T> {
  templateInputsSchema?: JsonSchema
}

export interface TemplateVariableOptions<T, InputsT extends Record<string, unknown>> extends VariableOptions<T> {
  default: ResolveFunction<T> | T
}
```

Expose a JS-style template variable API. `InputsT` is constrained to an object so Handlebars contexts are well-formed; the default keeps untyped call sites ergonomic:

```ts
export class TemplateVariable<T, InputsT extends Record<string, unknown>> extends Variable<T> {
  get(inputs: InputsT, options?: VariableGetOptions): Promise<ResolvedVariable<T>>
}

export function defineTemplateVar<T, InputsT extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  options: TemplateVariableOptions<T, InputsT>
): TemplateVariable<T, InputsT>

export { defineTemplateVar as templateVar }
```

Add typed error classes alongside the existing `VariableWriteError` family at `vars/index.ts:278`:

```ts
export class VariableCompositionError extends Error {}
export class VariableCompositionCycleError extends VariableCompositionError {}
export class VariableCompositionDepthError extends VariableCompositionError {}
export class VariableRenderError extends Error {}
```

`get(inputs)` does NOT validate `inputs` against `templateInputsSchema` at runtime; the schema is consumed only by `variablesValidate()` / strict push. This keeps the `vars` entrypoint free of a JSON Schema validator dependency.

### Tasks

```yaml
Task 1: Split managed-variable internals into focused modules
  MODIFY packages/logfire-api/src/vars/index.ts and CREATE files under packages/logfire-api/src/vars/:
    - Keep `src/vars/index.ts` as the public barrel; move helpers into focused modules.
    - Suggested split: `resolution.ts` (Variable, ResolvedVariable, providers), `config.ts` (VariableConfig normalization, push/pull), `validation.ts` (variablesValidate and helpers), plus the new files added in later tasks (`referenceSyntax.ts`, `composition.ts`, `template.ts`, `templateValidation.ts`).
    - Re-export every previously public symbol from `index.ts` so existing imports keep working.
    - Preserve `defineVar`, `var`, providers, codecs, and existing config behavior. No behavior changes in this task.
    - Add the new typed error classes (`VariableCompositionError`, `VariableCompositionCycleError`, `VariableCompositionDepthError`, `VariableRenderError`) next to `VariableWriteError` and re-export them.
  PATTERN: Mirror `VariableWriteError`/`VariableNotFoundError`/`VariableAlreadyExistsError` declarations at `vars/index.ts:278-286` for the new error classes. Tests already import from `./vars`, which now resolves to the barrel.

Task 2: Add Handlebars dependency and render helpers
  MODIFY pnpm-workspace.yaml:
    - Add a catalog entry for `handlebars`.
  MODIFY packages/logfire-api/package.json:
    - Add `handlebars` to dependencies (resolve version with `pnpm info handlebars version`).
  MODIFY packages/logfire-api/vite.config.ts:
    - Add `handlebars` to `pack.deps.neverBundle` if needed after checking build output.
  CREATE packages/logfire-api/src/vars/template.ts:
    - Convert supported inputs to a plain context object.
    - Render only string leaves within decoded JSON values.
    - Recursively wrap context string leaves with `new Handlebars.SafeString(value)` to disable HTML escaping per value (matches Python `_protect_value` strategy in `reference_syntax.py`). Do NOT use `Handlebars.compile(template, { noEscape: true })` - per-leaf `SafeString` is more conservative and is the documented Python behavior.
    - Pass through numbers/booleans/null unchanged; Handlebars will stringify them (null/undefined → empty string).
    - Re-encode rendered values with `JSON.stringify`.
  PATTERN: Python `render_serialized_string()` plus `_protect_value()` in `reference_syntax.py` decode JSON, recursively wrap string leaves with `SafeString`, render, and re-encode.

Task 3: Implement `@{}@` reference syntax
  CREATE packages/logfire-api/src/vars/referenceSyntax.ts:
    - Implement `renderOnce(template: string, context: Record<string, unknown>): string`.
    - Algorithm (must match Python `reference_syntax.render_once` step-for-step):
      1. Generate three per-template sentinels of the form `\x00logfire-<name>-<id>\x00` for `left-runtime-placeholder`, `right-runtime-placeholder`, `escaped-reference-start`. Use a monotonic counter or `crypto.randomUUID()` in place of Python's `id(template)`; the sentinel just needs to be collision-free with user content.
      2. Replace `\@{` with the escaped-reference sentinel BEFORE replacing `{{`/`}}` with the runtime-placeholder sentinels.
      3. Substitute `@{...}@` with `{{...}}` using `_REFERENCE_TAG` (see regex set below).
      4. Recursively wrap context string leaves with `new Handlebars.SafeString(...)` (Task 2).
      5. Render with `Handlebars.compile(handlebarsTemplate)(safeContext)` - no `noEscape` flag needed because string leaves are pre-wrapped.
      6. Restore in reverse order: runtime-placeholder sentinels back to `{{`/`}}`, then escaped-reference sentinel back to `@{`.
    - Export the regex set used across composition (one source of truth):
      - `HAS_REFERENCE = /(?<!\\)@\{/`
      - `REFERENCE_TAG = /(?<!\\)@\{(.*?)\}@/g` (lazy; used only for substitution)
      - `SIMPLE_REF = /(?<!\\)@\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}@/g` (used for collection)
      - `BLOCK_REF = /(?<!\\)@\{#\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|\}@)/g` (extracts the identifier after `#if`/`#each`/etc.)
    - Node.js 24 supports negative lookbehind in V8, so the `(?<!\\)` patterns work directly without rewrites.
  PATTERN: Python `reference_syntax.py` (algorithm) plus `composition.py` lines 32-44 (regex set and keyword list).

Task 4: Implement composition expansion
  CREATE packages/logfire-api/src/vars/composition.ts:
    - Export `MAX_COMPOSITION_DEPTH = 20` (confirmed value in Python `composition.py:46`), `ComposedReference`, `findReferences()`, `hasReferences()`, and `expandReferences()`.
    - Define `HBS_KEYWORDS = new Set(['else', 'this'])` and exclude these names from collected refs (matches Python `_HBS_KEYWORDS` at `composition.py:44`). They are valid inside `@{...}@` syntax (`@{else}@`, `@{this.field}@`) but are Handlebars built-ins, not variable names.
    - `hasReferences()`: use the `HAS_REFERENCE` regex re-exported from `referenceSyntax.ts`.
    - `findReferences()`: collect identifiers via `SIMPLE_REF` AND `BLOCK_REF`, dedupe in encounter order, drop names in `HBS_KEYWORDS`, return only the base name (first dotted segment for dotted refs).
    - Find simple refs `@{name}@`, dotted refs `@{name.field}@`, and block refs `@{#if name}@`.
    - Recursively walk decoded JSON strings, arrays, and objects.
    - Resolve each unique base variable name through an async callback (`ResolveFn` adapted to return `Promise<{serializedValue, label, version, reason}>`; mirrors Python tuple `(serialized, label, version, reason)` at `composition.py:82`).
    - Recurse into referenced serialized values before rendering the root value, incrementing depth on each recursion; throw `VariableCompositionDepthError` when depth exceeds `MAX_COMPOSITION_DEPTH`.
    - Detect cycles by tracking the current resolution chain; on revisit throw `VariableCompositionCycleError`. Internal recursion catches both and converts them to `ComposedReference` entries with `error` set - the public `expandReferences()` returns `(expanded, composed[])` rather than throwing, matching Python.
    - Preserve unresolved refs as literal text (do not substitute) and record a `ComposedReference` with `reason: 'unrecognized_variable'` and `error: null`.
    - Invalid referenced JSON: keep the literal `@{name}@` in output and record `error: 'non-JSON ...'` on the `ComposedReference` (Python test at `test_invalid_json_reference` asserts `'non-JSON' in composed[0].error`).
  PATTERN: Python `composition.py`; adapt `ResolveFn` to async JS providers.

Task 5: Integrate composition into resolution
  MODIFY packages/logfire-api/src/vars/index.ts:
    - In `Variable.resolve()`, after serialized provider lookup and before `JSON.parse()` / `codec.parse()`, call `expandReferences()` when `hasReferences(serialized.value)`.
    - Resolve referenced variables through the same provider, targeting key, and merged attributes.
    - On composition errors, fall back to the code default with `reason: 'other_error'`, preserving original label/version where useful.
    - Populate `ResolvedVariable.composedFrom`.
    - Store post-composition `serializedValue` and a codec-backed deserializer for later `render()`.
  PATTERN: Python `_expand_and_deserialize()`.

Task 6: Add `ResolvedVariable.render()`
  MODIFY the resolution module (post-split) that owns `ResolvedVariable`:
    - Add `serializedValue`, `deserializer`, and `composedFrom` fields to `ResolvedVariable`.
    - Implement `render(inputs?: Record<string, unknown>): T`.
    - Throw `VariableRenderError` if no serialized value or deserializer is available.
    - Render post-composition serialized JSON through Task 2, then deserialize with the original codec.
    - Ensure provider values, explicit label values, and serializable defaults can be rendered.
  PATTERN: Python `ResolvedVariable.render()`.

Task 7: Add template variable API
  CREATE packages/logfire-api/src/vars/template.ts (alongside the render helpers from Task 2):
    - Add `TemplateVariable<T, InputsT extends Record<string, unknown>>` extending `Variable<T>`.
    - Add `defineTemplateVar<T, InputsT extends Record<string, unknown> = Record<string, unknown>>()` as the primary public API and `templateVar` alias for convenience.
    - Store `templateInputsSchema` on the variable definition.
    - Make `get(inputs, options?)` run the pipeline: resolve -> compose -> render -> parse. Do NOT validate `inputs` against `templateInputsSchema` here; runtime validation is intentionally out of scope (see Clarifications).
    - Keep duplicate-name checks shared with `defineVar()` (re-use the existing registry).
    - Re-export from `vars/index.ts` barrel.
  PATTERN: Python `TemplateVariable.get(inputs)`, adjusted to JS async and explicit schema; mirror `defineVar()` registration semantics already in the resolution module.

Task 8: Sync `template_inputs_schema`
  MODIFY packages/logfire-api/src/vars/index.ts:
    - Add `template_inputs_schema?: JsonSchema | null` to `VariableConfig`.
    - Normalize it from local and remote configs.
    - Include it in `variableToConfig()`.
    - Include it in `variablesPush()` merge comparisons.
    - Include it in `configToApiBody()`.
    - Preserve it in local provider create/update/batch flows.
  PATTERN: Python `VariableConfig.template_inputs_schema` and `VariablesConfig.from_variables()`.

Task 9: Add validation for references and templates
  CREATE packages/logfire-api/src/vars/templateValidation.ts:
    - Extract template strings from serialized JSON values.
    - Walk composition graphs to include referenced variable values; reuse `findReferences()` from `composition.ts`.
    - Detect missing references and composition cycles (without throwing - report as validation issues).
    - Parse Handlebars templates and validate common `{{field}}` / dotted paths against `template_inputs_schema` object properties when present.
    - Document unsupported helpers and JSON Schema constructs instead of attempting full Python parity in the first pass.
    - Add warning/error fields to `ValidationReport` without breaking existing consumers.
  MODIFY validation module (post-split) to wire variablesValidate() and variablesPush():
    - Include reference warnings in validation output.
    - Make `strict: true` fail when references are cyclic, missing, or template inputs are incompatible.
    - This is the only surface that consults `template_inputs_schema` against actual templates; runtime `templateVar.get(inputs)` calls deliberately skip validation.
  PATTERN: Python `template_validation.py` and `_check_reference_warnings()`.

Task 10: Record composition on spans
  MODIFY packages/logfire-api/src/vars/index.ts:
    - When variables are instrumented, add a serialized `composed_from` span attribute if composition occurred.
    - Include referenced name, label, version, reason, and error.
    - Preserve existing span attributes `name`, `reason`, `label`, `version`, and `value`.
  PATTERN: Python span attribute recording in `_get_result_and_record_span()`.

Task 11: Add tests (one file per new module)
  CREATE packages/logfire-api/src/vars/referenceSyntax.test.ts:
    - Cover sentinel protection of `{{ }}` and `\@{`, conversion of `@{...}@` to Handlebars tags, and round-trip restoration.
  CREATE packages/logfire-api/src/vars/composition.test.ts:
    - Cover no refs, simple refs, multiple refs, duplicate refs, nested refs, structured JSON, lists, dotted fields, block helpers, escaped refs, unresolved refs, invalid referenced JSON, cycles (assert `VariableCompositionCycleError`), and depth limit (assert `VariableCompositionDepthError`).
  CREATE packages/logfire-api/src/vars/template.test.ts:
    - Cover `ResolvedVariable.render()`, structured values, object/list string leaves, `VariableRenderError` when no serialized value, template variable `get(inputs)`, override rendering, default rendering, and render errors. Add a test that confirms `get(inputs)` does NOT throw on schema-mismatched inputs (no runtime validation).
  CREATE packages/logfire-api/src/vars/templateValidation.test.ts:
    - Cover `template_inputs_schema`, unknown fields, transitive referenced templates, cycles, duplicate issue deduping, and `strict` push behavior.
  KEEP packages/logfire-api/src/vars.test.ts for the existing legacy behavior tests; only migrate cases when they overlap with the new modules.
  PATTERN: Use Python PR 1731 tests as the behavior checklist, but adapt assertions to JS strings and async APIs.

Task 12: Update docs, example, and release metadata
  MODIFY docs/managed-variables.md:
    - Add sections for variable composition, template rendering, and `defineTemplateVar()`.
    - Explain JS requires explicit `templateInputsSchema` for sync validation.
  MODIFY packages/logfire-api/README.md:
    - Add a concise composition/template example.
  MODIFY examples/node/variables.ts or CREATE examples/node/variable-composition.ts:
    - Demonstrate local config with reusable fragments, a composed prompt, and template inputs.
  CREATE .changeset/<descriptive-name>.md:
    - Minor bump for `logfire`.
    - Patch or no bump for `@pydantic/logfire-node` only if docs/re-export metadata changes require it.
```

### Integration Points

```yaml
PUBLIC API:
  - logfire/vars exports `defineTemplateVar`, `templateVar`, `TemplateVariable`, `ComposedReference`, `VariableCompositionError`, `VariableCompositionCycleError`, `VariableCompositionDepthError`, and `VariableRenderError`.
  - @pydantic/logfire-node/vars re-exports the same API automatically.

RESOLUTION:
  - `Variable.get()` composes serialized provider values before parsing.
  - `ResolvedVariable.render()` renders post-composition serialized values on demand.
  - `TemplateVariable.get()` renders automatically.

CONFIG SYNC:
  - `variablesBuildConfig()` includes `template_inputs_schema`.
  - `variablesPush()` and `variablesPushConfig()` write `template_inputs_schema`.
  - `variablesPullConfig()` normalizes `template_inputs_schema` from remote configs.

OBSERVABILITY:
  - Variable resolution spans include composition metadata without changing existing baggage behavior.
```

## Validation

Run focused checks first:

```bash
vp run logfire#test -- vars
vp run logfire#typecheck
vp run @pydantic/logfire-node#typecheck
```

Run package-level validation after dependency/config/docs changes:

```bash
pnpm run build
pnpm run format-check
```

Run the example manually if a new example is added:

```bash
cd examples/node
pnpm run variables
```

### Required Test Coverage

- [ ] Composition happy path: local config value `"Hello @{name}@"` resolves another variable and parses to the expected value.
- [ ] Nested composition: A references B references C, with `composedFrom` preserving nested metadata.
- [ ] Structured values: refs inside object/list string leaves expand without changing non-string fields.
- [ ] Dotted access: `@{brand.tagline}@` reads a property from an object variable.
- [ ] Block helpers: `if`, `unless`, `each`, `with`, and `else` work for `@{}@` composition.
- [ ] Escaping: `\@{name}@` becomes literal `@{name}@`; `{{runtime}}` survives composition.
- [ ] Error handling: missing refs stay literal; invalid referenced JSON records an error; cycles/depth errors fall back.
- [ ] Rendering: `ResolvedVariable.render()` fills `{{}}`, handles object/list leaves, disables HTML escaping, and reparses with the codec.
- [ ] Template variable: `defineTemplateVar().get(inputs)` composes then renders in one call.
- [ ] Sync: `template_inputs_schema` appears in built configs and remote create/update bodies.
- [ ] Validation: strict push catches incompatible template fields and reference cycles.
- [ ] Span metadata: composed references are visible on variable resolution spans.

## Unknowns & Risks

- Handlebars package size may matter for browser consumers of `logfire/vars`. Verify the pack output and keep the dependency isolated to the `vars` entry if possible.
- Template schema validation is deliberately pragmatic in the first pass: Handlebars AST/path extraction plus JSON Schema object-property checks. Full helper-aware Python parity can be a follow-up if needed.
- The Logfire Variables API must accept `template_inputs_schema` from JS write bodies. The Python PR suggests this is the intended wire field, but implementation should verify against a local or test API before release.
- Public naming is settled for this PRP: `defineTemplateVar` is the primary JS-style API and `templateVar` is a convenience alias. Avoid snake_case exports unless maintainers explicitly request Python parity later.
- New typed errors (`VariableCompositionError` and subclasses, `VariableRenderError`) become part of the public API surface; document them in the README and ensure they re-export from the barrel.
- Existing `variablesValidate()` returns a small report. Adding reference/template issues should be additive and should not change current `isValid` behavior except for new invalid cases.
- Composition of code defaults is deliberately out of scope to match Python PR 1731, even though docs/examples must be careful not to imply otherwise.

## Execution Notes

### Session 2026-05-08

- Implemented the feature with focused new modules for reference syntax, composition, template rendering, template validation, and typed errors. The existing resolution/config registry remains in `src/vars/index.ts`; a full mechanical split into `resolution.ts`/`config.ts` was deferred to avoid a broad refactor unrelated to the port.
- `TemplateVariable` is implemented in `src/vars/index.ts` rather than `template.ts` because `Variable` still lives in `index.ts`; moving it first would create a runtime ESM cycle. The public API and behavior match the PRP.
- JavaScript Handlebars rejects NUL sentinels during parsing, so the port uses collision-resistant plain-text sentinels instead of Python's `\x00...` markers while preserving the same protect/restore algorithm.
- The Node variables example now disables telemetry export and variable instrumentation so it can run as a local variables demo without requiring a running OTLP endpoint.

## Reference Syntax Port Checklist

Direct translation of Python `reference_syntax.py` and `composition.py` (lines 32-46):

```ts
// referenceSyntax.ts — exported regex set (single source of truth)
export const HAS_REFERENCE = /(?<!\\)@\{/
export const REFERENCE_TAG = /(?<!\\)@\{(.*?)\}@/g // substitution; lazy
export const SIMPLE_REF = /(?<!\\)@\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}@/g
export const BLOCK_REF = /(?<!\\)@\{#\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|\}@)/g
export const HBS_KEYWORDS = new Set(['else', 'this'])

// composition.ts
export const MAX_COMPOSITION_DEPTH = 20
```

Algorithm for `renderOnce(template, context)` mirroring Python:

1. Three sentinels of the form `\x00logfire-<name>-<unique>\x00` for `left-runtime-placeholder`, `right-runtime-placeholder`, `escaped-reference-start`. Use a module-level counter or `crypto.randomUUID()` for uniqueness.
2. `protectedTemplate = template.replaceAll('\\@{', escapedRefSentinel).replaceAll('{{', leftSentinel).replaceAll('}}', rightSentinel)` - escape replacement runs first.
3. `handlebarsTemplate = protectedTemplate.replace(REFERENCE_TAG, '{{$1}}')`.
4. Recursively wrap context string leaves in `new Handlebars.SafeString(value)` (preserve dict/list structure; pass numbers/booleans/null through).
5. `result = Handlebars.compile(handlebarsTemplate)(safeContext)` - no `noEscape` flag.
6. Restore: `result.replaceAll(leftSentinel, '{{').replaceAll(rightSentinel, '}}').replaceAll(escapedRefSentinel, '@{')`.

### Parity tests to translate from Python

From `tests/test_variable_composition.py` in the Python repo, port these cases (assertion shape adjusts to JS strings + async APIs):

- `test_invalid_serialized_value_is_returned_unchanged` - non-JSON input passes through.
- `test_no_references` - input without `@{}@` is unchanged, `composed === []`.
- `test_simple_string_reference` - `"@{greeting}@ World"` → `"Hello World"`, `composed[0]` has `name`, `value`, `label='production'`, `version=1`, `reason='resolved'`, `error=null`.
- `test_multiple_references`, `test_duplicate_references`, `test_nested_references`.
- `test_dotted_field_access` - `@{config.prompt}@` reads property from object variable.
- `test_cycle_detection` - mutually-referencing vars produce `error` on `composed`, no infinite loop.
- `test_self_reference` - var referring to itself records cycle error.
- `test_max_depth_overflow` - chain longer than 20 produces `VariableCompositionDepthError` recorded as `error`.
- `test_unresolved_simple_ref` and `test_unresolved_dotted_ref` - missing refs stay literal in output.
- `test_unresolved_with_other_resolved` - mixed resolved/unresolved.
- `test_unresolved_only` - all-unresolved input is unchanged.
- `test_number_reference`, `test_boolean_reference`, `test_object_reference` - non-string variable values render via Handlebars stringification.
- `test_structured_type_with_references` - refs inside object string values.
- `test_list_with_references` - refs walk into lists; non-string entries pass through.
- `test_keyword_block_references_are_ignored` - `@{#if this}@yes@{/if}@` is left unchanged when no var named `this`.
- `test_json_encoding_newlines`, `test_json_encoding_quotes`, `test_json_encoding_unicode`, `test_json_encoding_backslashes` - rendered values reparse cleanly.
- `test_escape_sequence` - `\@{ref}@` becomes literal `@{ref}@`; the second unescaped `@{ref}@` resolves.
- `test_escape_only` - input with only escaped refs returns no `composed` entries.
- `test_invalid_json_reference` - `composed[0].error` contains the substring `'non-JSON'`.
- `TestFindReferences` block - simple/dotted/block/duplicate/escape cases for `findReferences()`.

**Confidence: 8/10** for one-pass implementation success. Reference-syntax algorithm, regex set, depth constant, keyword filter, and HTML-escaping strategy are now pinned to source-truth values; the residual uncertainty is wire-format reciprocity for `template_inputs_schema` (needs a real-API round-trip), unspecified integration glue (fallback `composedFrom`, span attribute key, `ValidationReport` field names), the pre-feature module split, and codec re-parse semantics around rendered string values.
