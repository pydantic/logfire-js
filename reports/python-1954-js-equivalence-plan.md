# Python PR #1954 parity review for JS variable composition

Source reviewed:

- Python PR: https://github.com/pydantic/logfire/pull/1954
- Python branch: `feature/variable-composition-native-handlebars`
- Python head inspected: `20f24a7` (`Restore 100% coverage after the composition feedback changes`)
- JS branch inspected: `petyosi/variable-composition-templates`
- JS head inspected: `6467ea2` (`Handle nested variable composition blocks`)

Primary Python files reviewed:

- `/private/tmp/logfire-pr1954/logfire/variables/composition.py`
- `/private/tmp/logfire-pr1954/logfire/variables/_handlebars.py`
- `/private/tmp/logfire-pr1954/logfire/variables/reference_syntax.py`
- `/private/tmp/logfire-pr1954/logfire/variables/template_validation.py`
- `/private/tmp/logfire-pr1954/logfire/variables/variable.py`
- `/private/tmp/logfire-pr1954/logfire/variables/abstract.py`
- `/private/tmp/logfire-pr1954/logfire/variables/remote.py`
- `/private/tmp/logfire-pr1954/logfire/variables/__init__.py`
- `/private/tmp/logfire-pr1954/logfire/_internal/config.py`
- `/private/tmp/logfire-pr1954/logfire/_internal/main.py`
- Python tests in `tests/test_variable_composition.py`, `tests/test_variable_templates.py`,
  `tests/test_template_validation.py`, and `tests/test_push_variables.py`

Primary JS files reviewed:

- `packages/logfire-api/src/vars/composition.ts`
- `packages/logfire-api/src/vars/referenceSyntax.ts`
- `packages/logfire-api/src/vars/templateValidation.ts`
- `packages/logfire-api/src/vars/index.ts`
- `packages/logfire-api/src/vars/composition.test.ts`
- `packages/logfire-api/src/vars/templateValidation.test.ts`

## Executive summary

The JS branch has the first version of variable composition and already includes the later
fix for nested unresolved same-helper blocks. It is not yet semantically equivalent to the
latest Python PR.

The biggest new Python changes to port are:

1. Runtime resolution semantics changed substantially:
   provider and context override values are composed strictly, while code defaults are the
   lenient last resort. A missing reference in a provider value now falls back to the code
   default, but a missing reference in the code default renders empty with a warning.
2. Context overrides now participate in the compose -> render -> deserialize pipeline when
   serializable. JS currently returns overrides directly.
3. `ComposedReference` now has explicit `fatal` metadata. Fatal means cycle or depth overflow.
   Missing references and malformed referenced values are soft in non-strict composition.
4. Python switched composition parsing/rendering to native custom-delimiter Handlebars
   (`@{` / `}@`) and AST-aware dependency extraction. JS still uses regex conversion plus
   protection logic. That is close for common cases but not equivalent for full Handlebars
   syntax.
5. Template variables now have a render-time mismatch policy:
   `warn`, `error`, or `ignore`, configurable at instance level and per variable.
6. Push/validate now returns structured reference and template-field issues:
   `reference_errors`, `reference_cycles`, and `template_field_issues`.
   Cycles always block push; missing refs and template field issues block only in strict mode.
7. Push-time template validation now follows composition paths from each template root,
   includes local code defaults, server labels, latest versions, and followed `LabelRef`s,
   and reports where each bad field was found.
8. Remote provider hardening in Python includes read-after-write forced refreshes,
   failed-startup-fetch handling, SSE reconnect backoff behavior, variable-type write errors,
   and snapshot isolation. JS has some of these already but not all.

## Priority matrix

| Priority | Area                           | Python behavior                                                                                                                                              | JS status                                                                                                      | Porting action                                                                                |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P0       | Provider composition fallback  | Provider and explicit-label values compose in strict mode; unresolved refs fall back to code default.                                                        | Provider values compose non-strict and preserve unresolved refs literally.                                     | Add strict composition mode and update `Variable.resolve()`.                                  |
| P0       | Code default composition       | Code defaults are composed when provider has no value or provider composition fails; strict first, then non-strict fallback, then raw default.               | Default fallback returns raw default and usually does not compose it.                                          | Add serialized-default resolution path with strict/non-strict retry.                          |
| P0       | Context override pipeline      | Serializable overrides compose/render/deserialize like stored values; unserializable overrides return verbatim.                                              | Overrides return directly; no composition or template rendering.                                               | Serialize overrides through the codec where possible and feed them through the same resolver. |
| P0       | Template mismatch policy       | `TemplateVariable.get()` checks post-composition `{{field}}` refs against inputs schema with `warn`, `error`, `ignore`.                                      | Validation is push-time only; render-time missing fields silently render/fallback depending on render failure. | Add policy type, options, error class, and render-time checks.                                |
| P0       | Push validation shape          | Reports `reference_errors`, `reference_cycles`, `template_field_issues`; cycles always block.                                                                | Reports `referenceWarnings` and `templateInputWarnings`; strict throws only when whole report invalid.         | Replace or augment report fields and strict/non-strict behavior.                              |
| P1       | AST-correct composition parser | Native `@{...}@` Handlebars environment supports dotted refs, helpers, blocks, subexpressions, lookup args, parent refs, and malformed-template diagnostics. | Regex extraction/conversion handles common simple/block refs, but not full Handlebars dependency semantics.    | Either add a real custom-delimiter parser layer or harden current Handlebars AST conversion.  |
| P1       | `ComposedReference.fatal`      | Fatal is explicit, defaults to `False`, and is only true for cycle/depth errors.                                                                             | Fatal inferred by string matching in `hasFatalCompositionError()`.                                             | Add `fatal: boolean` and update span serialization/tests.                                     |
| P1       | Template field attribution     | Issues include `root_variable`, `found_in_variable`, `found_in_label`, `reference_path`, `field_name`.                                                       | Issues include only variable/label/path/message.                                                               | Introduce equivalent TS type and graph walk.                                                  |
| P1       | LabelRef in validation         | Template validation follows label refs and reports issue against the serving label.                                                                          | Compatibility validation skips `LabelRef` labels.                                                              | Add label-ref follow path for template validation.                                            |
| P2       | Dependency gate                | Python eagerly errors if `logfire[variables]` deps are missing.                                                                                              | JS has direct dependency on `handlebars`; no optional dependency gate needed.                                  | No direct port unless a new parser dependency is optional.                                    |
| P2       | Remote provider hardening      | Snapshot isolation and SSE clean-close backoff are explicit.                                                                                                 | JS has read-after-write and failed-fetch handling; snapshot isolation and SSE backoff behavior differ.         | Add focused tests and fix deltas.                                                             |

## Runtime composition semantics to port

### Strict vs non-strict composition

Python now has a `strict` flag on `expand_references()`:

- `strict=True`: unresolved `@{ref}@` or `@{ref.field}@` raises during rendering.
- `strict=False`: unresolved refs render empty/falsy, while metadata records a soft error.

The Python runtime uses this split deliberately:

- Provider values and explicit label values use strict composition.
- Serializable context overrides use strict composition.
- Code defaults are the last resort and use strict first, then non-strict if strict failed
  because of an unresolved composition reference, then raw default if still unusable.

Current JS behavior:

- `expandReferences()` has no strict option.
- Missing references are protected and restored as literal `@{ref}@`.
- `hasFatalCompositionError()` uses string matching for cycle/depth errors.
- Provider composition only falls back on thrown composition errors or inferred fatal errors.
- Missing provider refs usually produce a partially composed value, not a code-default fallback.

Required JS work:

1. Add `strict?: boolean` to `ExpandReferencesOptions`.
2. In strict mode, do not protect unresolved references. Let render fail, or explicitly throw a
   `VariableCompositionError` that includes the missing reference.
3. In non-strict mode, render unresolved refs as Handlebars would:
   interpolation -> empty string, `#if` -> falsy, `#unless` -> truthy body, `#each` -> zero items.
   This means JS should not preserve missing refs literally when matching Python behavior.
4. Return soft metadata for missing refs in non-strict mode:
   `error: "Referenced variable 'x' could not be resolved."`, `fatal: false`.
5. Return fatal metadata for cycles/depth:
   `fatal: true`.

Important Python tests to mirror:

- `test_unresolvable_reference`
- `test_unresolvable_reference_strict_raises`
- `test_unresolvable_dotted_reference`
- `test_unresolvable_dotted_reference_alongside_resolved_ref`
- `test_unresolvable_simple_and_dotted_reference_same_base`
- `test_resolved_dotted_ref_alongside_unresolved_simple_ref`
- `test_block_if_missing_ref_is_falsy`
- `test_block_if_missing_ref_no_else_renders_empty`
- `test_block_unless_missing_ref_shows_body`
- `test_block_each_missing_ref_is_empty`
- `test_missing_ref_interpolation_empty_alongside_falsy_block`

### Code default composition

Python composes a variable's own code default when the provider returns no value.
It also uses the code default as fallback when a provider value fails strict composition,
rendering, or validation.

Current JS behavior:

- `resolvedWithDefault()` returns `resolveMaybeFunction(variable.defaultValue, ...)` directly.
- If provider composition fails, JS falls back to raw default.
- If a referenced variable is missing, the provider value often remains partially literal.

Required JS work:

1. Add a helper that resolves the code default to a serialized JSON value if possible.
2. If the default is static or the resolve function returns a serializable value, run it through
   compose -> optional template render -> deserialize.
3. Use strict composition first. If strict composition fails because of missing refs, retry
   non-strict and warn.
4. If default serialization fails, return the typed default value verbatim with reason
   `code_default` when this is the normal no-provider path.
5. Cache callable default results within one `get()` call, including exceptions, so fallback
   paths do not invoke a default function multiple times.

Important Python tests to mirror:

- `test_code_default_composition_when_provider_has_no_value`
- `test_top_level_reason_is_code_default_when_provider_has_no_value`
- `test_reference_falls_back_to_registered_code_default`
- `test_callable_default_invoked_once_on_composition_failure`
- `test_failing_callable_default_invoked_once_per_get`
- `test_provider_value_falls_back_when_referenced_default_unserializable`
- `test_unserializable_default_skips_default_composition`
- `test_code_default_with_unresolved_reference_renders_empty`

### Context overrides

Python changed override handling:

- If an override serializes through the variable's type adapter, it runs through the same
  compose -> render -> deserialize path as a stored value.
- If a top-level override cannot be serialized, it returns verbatim with reason
  `context_override`.
- If a referenced variable's override cannot be serialized while resolving parent composition, it
  warns and falls through to provider/code default lookup because parent composition needs a
  serialized value.
- Overrides of referenced variables are visible to composition of parent variables.

Current JS behavior:

- Top-level overrides return directly from `Variable.resolve()`.
- Referenced-variable overrides are likely visible when resolving child refs through the
  provider only if provider lookup consults override context; the current code does not route
  composition references through `Variable.resolve()` and therefore does not fully match Python.

Required JS work:

1. Change top-level override handling to attempt `serializeWithCodec(this.codec, overrideValue)`.
2. If serialization succeeds, resolve that serialized candidate with strict composition and
   normal template rendering.
3. If top-level override serialization fails, return the override value directly with reason
   `context_override`.
4. For child references, add a shared lookup helper that checks:
   context override -> explicit provider/label -> registered variable code default.
5. Ensure a referenced variable's serializable override is reflected in
   `composedFrom.reason === 'context_override'`.
6. If a referenced override cannot serialize, warn and continue to provider/code default lookup.

Important Python tests to mirror:

- `test_override_participates_in_composition`
- `test_render_fn_applies_to_context_override`
- `test_override_propagates_through_composition`
- `test_resolve_function_override_propagates_through_composition`
- `test_unserializable_override_falls_through_to_provider`
- `test_override_unserializable_value_returned_typed`

## Composition parser and renderer parity

### Python native custom-delimiter Handlebars

Python now delegates composition to `pydantic-handlebars` with:

- composition delimiters `@{` and `}@`
- runtime delimiters `{{` and `}}`
- cached composition/runtime templates
- AST-aware dependency extraction
- schema compatibility checks from the same Handlebars library

This gives Python support for:

- simple refs: `@{name}@`
- dotted refs: `@{user.name}@`
- block helpers: `@{#if flag}@...@{/if}@`
- dotted block headers: `@{#if user.active}@`
- helper subexpressions and helper arguments: `@{lookup obj key}@`
- parent context references in blocks
- escaped composition syntax using Handlebars backslash parity
- parse-error reporting without crashing validation

Current JS behavior:

- `referenceSyntax.ts` converts `@{...}@` to `{{...}}` with regexes and protects runtime
  `{{...}}` placeholders with sentinels.
- `composition.ts` extracts references using `SIMPLE_REF`, `BLOCK_REF`, and `REFERENCE_TAG`.
- The branch now has a stack-based block range scanner for unresolved nested same-helper blocks.
- This is not equivalent to Python's AST dependency extraction for helper args,
  subexpressions, malformed syntax, and escaping parity.

Required JS work options:

Option A, preferred if feasible:

1. Keep using `handlebars`, but build a parser path that converts `@{...}@` to
   `{{...}}` only after protecting runtime templates.
2. Parse the converted composition template with `Handlebars.parse()`.
3. Extract top-level dependency names from the AST rather than from regexes.
4. Render with `Handlebars.compile(..., { strict })` or explicit missing-helper/missing-field
   checks to emulate Python strict behavior.
5. Cache compiled templates and extracted dependencies.

Option B, lower-risk incremental hardening:

1. Extend current regex/protection code to cover all tests above.
2. Add `findReferencesAndErrors()` to report parse errors rather than silently returning no refs.
3. Accept that this is not a full parity guarantee unless all Python parser tests pass in JS.

Specific gaps to cover:

- `findReferences()` should return sorted unique names. Python sorts refs for deterministic
  composition order; JS currently preserves discovery order.
- Escaped-only values should still pass through the renderer so `\@{x}@` unescapes consistently.
  JS already handles some of this, but Python's backslash parity behavior is broader.
- Malformed templates should not crash `findReferences()` or push validation.
- `@{true}@` and other reserved literals should not crash extraction.
- Deeply nested decoded JSON should not trigger recursion crashes. Python added an iterative
  walk in `find_references_and_errors()`.

Important Python tests to mirror:

- `test_find_references_block_helpers`
- `test_find_references_block_and_simple`
- `test_find_references_ignores_handlebars_keywords`
- `test_malformed_template_does_not_raise`
- `test_reserved_name_does_not_raise`
- `test_find_references_and_errors_reports_malformed`
- `test_find_references_and_errors_clean_value`
- `test_deeply_nested_value_does_not_recurse`
- `test_dotted_path_in_block_helper_header`
- `test_each_iterates_top_level_list`
- `test_each_with_parent_ref_reaches_top_context`
- `test_lookup_helper_with_two_args`
- `test_lookup_helper_arguments_are_refs`
- `test_known_helpers_are_not_treated_as_context_refs`

## `ComposedReference` and span attributes

Python `ComposedReference` now has:

- `name`
- `value`
- `label`
- `version`
- `reason`
- `error`
- `composed_from`
- `fatal`

Python span serialization includes nested `composed_from` but intentionally omits `value`.
The `fatal` flag is used in runtime decision-making, not necessarily span attributes.

Current JS:

- `ComposedReference` lacks `fatal`.
- `hasFatalCompositionError()` checks strings for `VariableCompositionCycleError` and
  `VariableCompositionDepthError`.
- `toComposedFromAttribute()` serializes only `name`, `version`, `label`, `reason`, `error`
  and does not include nested `composedFrom`.

Required JS work:

1. Add `fatal: boolean` to `ComposedReference`.
2. Replace string matching in `hasFatalCompositionError()` with `reference.fatal === true`.
3. Set `fatal: true` only for cycle/depth errors.
4. Preserve `fatal: false` for normal/soft references, matching Python's dataclass default.
5. Ensure OTel `composed_from` span attribute shape matches Python:
   include nested `composed_from`, omit raw `value` and `fatal`, keep nulls for absent
   label/version/error, and omit empty nested `composed_from`.

Important Python tests to mirror:

- `test_cycle_detection`
- `test_self_reference_cycle`
- `test_depth_limit`
- `test_span_attributes_with_composition`
- `test_span_attributes_include_nested_composition_chain`
- `test_span_attributes_without_composition`

## Template variable render-time mismatch policy

Python adds:

- `TemplateMismatchPolicy = 'warn' | 'error' | 'ignore'`
- `TemplateInputsMismatchError`
- `VariablesOptions.template_mismatch_policy`
- `LocalVariablesOptions.template_mismatch_policy`
- `template_var(..., template_mismatch_policy=...)`

Effective policy:

1. Per-variable value wins when provided.
2. Otherwise instance-level `VariablesOptions` / `LocalVariablesOptions` wins.
3. Otherwise default is `warn`.

Behavior:

- `warn`: emit a non-fatal warning and render anyway. Missing fields render empty.
- `error`: raise `TemplateInputsMismatchError` and bypass default fallback.
- `ignore`: render silently.

Current JS:

- `TemplateVariableOptions` does not include a mismatch policy.
- `VariablesOptions` and `LocalVariablesOptions` do not include a mismatch policy.
- `TemplateVariable.get()` renders `{{...}}` after `super.get()` and falls back to default on
  render/validation errors.
- There is no runtime check that `{{field}}` refs match `templateInputsSchema`.

Required JS work:

1. Add:
   `export type TemplateMismatchPolicy = 'warn' | 'error' | 'ignore'`.
2. Add `TemplateInputsMismatchError extends Error`.
3. Extend options:
   - `VariablesOptions.templateMismatchPolicy?: TemplateMismatchPolicy`
   - `LocalVariablesOptions.templateMismatchPolicy?: TemplateMismatchPolicy`
   - `TemplateVariableOptions.templateMismatchPolicy?: TemplateMismatchPolicy`
4. Store runtime option in `runtimeState`.
5. Before rendering in `TemplateVariable.get()`, inspect the post-composition serialized value
   and check `{{...}}` paths against `templateInputsSchema`.
6. Under `error`, throw `TemplateInputsMismatchError` without fallback.
7. Under `warn`, warn but continue rendering.
8. Under `ignore`, skip the check.

Warning surface in JS needs a product decision:

- Python uses `RuntimeWarning` with a filter-independent emitter.
- JS could use `console.warn()`, an optional callback, or a structured field on
  `ResolvedVariable`.
- For SDK parity and low API surface, `console.warn()` is the simplest, but it is noisier in
  production and tests.

Important Python tests to mirror:

- `TestTemplateMismatchPolicy.test_default_policy_is_warn`
- `test_warn_policy_is_filter_independent` - translate to "warning does not change result"
- `test_no_warning_when_inputs_satisfied`
- `test_per_variable_error_raises`
- `test_per_variable_ignore_renders_silently`
- `test_instance_level_error`
- `test_variable_level_relaxes_instance_error`
- `test_variable_level_escalates_instance_warn`
- `test_variable_level_relaxes_instance_warn_to_ignore`
- `test_template_inputs_mismatch_error_bypasses_default_fallback`

## Push and validate parity

### Report shape

Python `ValidationReport` now includes:

- `errors`
- `variables_not_on_server`
- `description_differences`
- `reference_errors`
- `reference_cycles`
- `template_field_issues`

`ValidationReport.is_valid` is false if any of these are present:

- codec/type errors
- variables not on server
- reference errors
- template field issues

Current JS `ValidationReport` includes:

- `errors`
- `variablesNotOnServer`
- `descriptionDifferences`
- `referenceWarnings`
- `templateInputWarnings`
- `isValid`

Required JS work:

1. Remove/replace old warning fields; do not keep compatibility aliases because this feature has
   not shipped in JS.
2. Add equivalent camelCase fields:
   - `referenceErrors: string[]`
   - `referenceCycles: string[]`
   - `templateFieldIssues: TemplateFieldIssue[]`
3. Make `referenceErrors` include both missing/malformed refs and cycles; `referenceCycles` is
   the cycle subset.
4. Make `isValid` false when `errors`, `variablesNotOnServer`, `referenceErrors`, or
   `templateFieldIssues` are non-empty. Description differences do not make the report invalid.
5. Remove old `referenceWarnings` and `templateInputWarnings` names; this feature has not shipped
   in JS, so no aliases are required.

### Push strict/non-strict behavior

Python push behavior:

- `strict` defaults to `False`.
- Reference cycles always block push, even when `strict=False`.
- Missing references block only with `strict=True`.
- Template field issues block only with `strict=True`.
- Incompatible labels block only with `strict=True`.
- Non-strict push prints warnings and still applies changes.
- Dry-run is handled after the blocking gates, so `dry_run=True` does not bypass cycles or strict
  blockers.

Current JS:

- `variablesPush(..., { strict: true })` throws if `!report.isValid`.
- `strict: false` ignores invalid reports while still returning only `{ changes, dryRun }`.
- Cycles are treated as validation warnings and do not separately block non-strict push.
- The result shape cannot currently represent Python's `False` "blocked before mutation" outcome.
- The result shape also needs a JS-native mapping for Python's `False` no-op outcome.
- Provider I/O and write failures are better treated as thrown JS operational errors, not
  validation blocks.

Required JS work:

1. Classify reference issues into missing/malformed refs vs cycles.
2. Block cycles regardless of strict mode.
3. Default omitted `strict` to `false`, matching Python.
4. Block missing refs, template field issues, and incompatible labels only when strict.
5. Emit `console.warn()` warnings in non-strict mode while keeping `VariablePushResult` small;
   structured diagnostics remain available through `variablesValidate()`.
6. Add minimal blocked result fields, e.g. `blocked: boolean` and `blockedBy`, so strict/cycle
   gates can return a Python-like "not applied" result without throwing and without embedding the
   full validation report. Keep planned `changes` populated when diff/change computation
   succeeds, because Python prints the diff before blocking.
   `blockedBy` should contain only the first blocking category in Python gate order, without
   later blocker categories, counts, or details:
   `reference_cycles`, `reference_errors`, `template_field_issues`, `incompatible_labels`.
7. Preserve Python's ordering: compute changes, run blocking gates, then treat dry-run as a
   successful no-mutation result only when the push is not blocked.
8. For no-op pushes, return `blocked: false`, `blockedBy: []`, `changes: []`, and `dryRun`.
9. Keep provider fetch/apply failures as thrown operational errors, preferably
   `VariableWriteError` where applicable; do not return `blocked: true` for I/O failures.
10. Update error messages to distinguish:

- codec incompatibility
- reference cycles
- missing references
- template field issues

### Reference graph validation

Python `_check_reference_errors()`:

- Walks from every local variable.
- Includes local static code defaults.
- Includes every server label value and latest version.
- Walks transitively into server-only variables.
- Reports missing refs even through server-only chains.
- Detects cycles whose midpoint is server-only.
- Captures malformed composition parse errors as reference errors.
- Handles deeply nested graphs with a clean blocking error instead of crashing.

Current JS:

- Validation expands each label/latest for each local variable.
- It validates only values of variables that are registered locally.
- It skips `LabelRef` labels in codec validation.
- It does not have a separate graph-wide reference checker.

Required JS work:

1. Add `findReferencesAndErrors(serializedValue)` to composition/reference syntax code.
2. Build a graph walk from registered local variables into server config variables.
3. Include local static defaults when serializable.
4. Include server `LabeledValue` labels and `latest_version`.
5. Include parse errors in `referenceErrors`.
6. Detect cycles on the assembled graph.
7. Catch excessive recursion/depth and convert to a blocking reference cycle/error.

Important Python tests to mirror:

- `test_compute_diff_reference_errors`
- `test_compute_diff_reference_errors_through_server_only_chain`
- server-only cycle cases in `test_push_variables.py`
- `test_check_reference_errors_recursion_limit`
- `test_format_diff_reference_errors`
- `test_format_diff_reference_cycles`
- `test_validation_report_reference_errors_are_invalid`
- `test_push_variables_strict_fails_with_reference_errors`

### Template field issues

Python `TemplateFieldIssue` includes:

- `field_name`: e.g. `nickname`
- `found_in_variable`: the variable whose value literally contains the bad `{{field}}`
- `found_in_label`: server label, `latest`, or `None` for code default
- `reference_path`: composition path from the template root
- `root_variable`: the `TemplateVariable` whose inputs schema was applied

This is important because a shared fragment can be valid for one template variable and invalid
for another. The root variable is the variable whose schema is being used.

Current JS:

- `TemplateInputValidationIssue` has `path`, `variableName`, optional `label`, and `message`.
- Validation happens after expanding one value, so attribution to composed fragments and root
  variables is weaker.

Required JS work:

1. Add a `TemplateFieldIssue` interface with camelCase names:
   - `fieldName`
   - `foundInVariable`
   - `foundInLabel?: string`
   - `referencePath: string[]`
   - `rootVariable`
   - `message`
2. Add `validateTemplateComposition(rootVariable, schema, getAllSerializedValues)`.
3. For each local `TemplateVariable`, walk its own values plus composed values and validate every
   `{{...}}` string against that root schema.
4. Deduplicate only within one root. Do not dedupe the same shared bad fragment across roots.
5. Include:
   - local static default (`undefined`/missing label in JS instead of Python `None`)
   - server labels after following `LabelRef`
   - `latest_version` as label `'latest'`
6. Skip callable/function defaults.
7. Skip unserializable local defaults without crashing.

Important Python tests to mirror:

- `test_compute_diff_template_field_issues_local_default`
- `test_compute_diff_template_field_issues_server_label`
- `test_compute_diff_template_field_issues_follow_composition`
- `test_compute_diff_template_field_issues_reported_per_root`
- `test_compute_diff_template_field_issues_from_latest_version`
- `test_compute_diff_template_field_issues_code_default_with_latest_version`
- `test_compute_diff_template_field_issues_label_ref_reported_against_label`
- `test_compute_diff_template_field_issues_skips_resolve_function_default`
- `test_format_diff_template_field_issues`
- `test_validation_report_format_template_field_issues`
- `test_push_variables_strict_fails_with_template_field_issues`

## LabelRef behavior

Python label refs are more visible in validation now:

- Runtime `get_serialized_value_for_label()` follows refs.
- `LabelRef('latest')` returns latest version serialized value if present.
- `LabelRef('code_default')` returns no serialized value and reason `missing_config`.
- Label-to-label refs can chain.
- Label ref cycles return no serialized value.
- Template field validation follows refs and reports the problem against the serving label.

Current JS has `LabelRef` support in config normalization and runtime resolution, but validation
skips `LabelRef` labels in some paths.

Required JS work:

1. Audit `resolveSerializedValueForLabel()` and `resolveVariableConfigForLabel()` against Python
   `VariableConfig.follow_ref()`.
2. Add tests for:
   - latest ref with and without latest version
   - code_default ref
   - label-to-label chain
   - ref cycle
   - non-existent label
3. In template field validation, follow refs and report the issue under the original label name.
4. Preserve codec validation behavior: ref-only labels should not be directly parsed as values,
   but their resolved value should be considered where appropriate for template validation.

Important Python tests to mirror:

- `test_follow_ref_to_latest`
- `test_follow_ref_to_latest_no_latest_version`
- `test_follow_ref_chain`
- `test_follow_ref_cycle_detection`
- `test_follow_ref_to_nonexistent_label`
- `test_follow_ref_to_code_default`
- `test_ref_only_label_skipped_in_validation`
- `test_compute_diff_template_field_issues_label_ref_reported_against_label`

## Public API and configuration changes

Python public API changes:

- `TemplateMismatchPolicy` is exported.
- `TemplateInputsMismatchError` is exported.
- `template_var()` accepts `template_mismatch_policy`.
- `VariablesOptions` and `LocalVariablesOptions` accept `template_mismatch_policy`.
- `var()` and `template_var()` call `ensure_variables_dependencies()` eagerly.
- `var()` and `template_var()` reject `default=None` unless `type` is explicit.
- Declaration-time warning when a plain `var()` composes a `template_var()`.

JS equivalents to add:

1. Export `TemplateMismatchPolicy`.
2. Export `TemplateInputsMismatchError`.
3. Add `templateMismatchPolicy` to `defineTemplateVar()` options.
4. Add `templateMismatchPolicy` to `configureVariables()` options.
5. Add declaration-time warning when:
   - a new plain variable static default references an already registered template variable
   - a new template variable is referenced by an already registered plain variable
6. Skip declaration-time warning for function defaults because invoking them at declaration time
   would be wrong.

Potential JS difference:

- Python's `default=None` inference rule does not map cleanly to JS. JS already requires a default
  and infers codec from it, but `null` is a valid JS value. Do not force Python's `None` rule onto
  JS unless the product wants stricter type inference around `null`.

Important Python tests to mirror:

- `test_plain_var_composing_template_var_warns`
- `test_warns_regardless_of_declaration_order`
- `test_template_var_composing_template_var_does_not_warn`
- `test_plain_var_composing_plain_var_does_not_warn`

## Remote provider hardening

Python latest PR includes or reinforces these provider behaviors:

- `refresh(force=True)` waits for any in-flight non-forced refresh and then fetches fresh data.
  This protects read-after-write after create/update/delete.
- Failed startup fetch sets `_has_attempted_fetch = True`, so every variable resolution does not
  repeatedly block on a fresh failed request.
- SSE reconnect backoff is not reset until actual event data is received. A clean immediate close
  should not reconnect in a tight loop.
- Clean stream end backs off before reconnect.
- Create/update/delete refresh after successful write.
- Variable-type API failures raise `VariableWriteError`.
- Local provider `get_all_variables_config()` returns an isolated snapshot.

Current JS status:

- `refresh(force)` already queues a forced refresh after an in-flight refresh.
- `refresh().finally()` sets `hasAttemptedFetch = true` even on failure.
- create/update/delete call `await this.refresh(true)` after successful write.
- `readSseStream()` releases the reader lock in `finally`.
- `runSseLoop()` currently resets `reconnectDelay = 1_000` immediately after a successful HTTP
  response, before event data is received. This differs from Python's busy-loop protection.
- `getAllVariablesConfig()` returns `this.config ?? { variables: {} }` directly for remote and
  `this.config` directly for local. That is not snapshot-isolated.
- `listVariableTypes()` does not wrap network errors with `VariableWriteError`; it only throws
  `VariableWriteError` for malformed array shape. Python has explicit network-error tests.

Required JS work:

1. Add snapshot cloning for `getAllVariablesConfig()` on both local and remote providers.
   Use structured clone or JSON round-trip plus normalization, depending on conventions.
2. Change SSE backoff reset so it happens only after valid data is received.
3. Back off on clean stream end, not just thrown fetch/read errors.
4. Wrap `listVariableTypes()` network errors using `toVariableWriteError('Failed to list variable types', error)`.
5. Add tests for all provider hardening behaviors.

Important Python tests to mirror:

- `test_get_all_variables_config_returns_isolated_snapshot`
- `test_network_failure_marks_attempted_fetch`
- `test_refresh_with_force`
- `test_force_refresh_via_worker`
- `test_create_variable_success`
- `test_update_variable_success`
- `test_delete_variable_success`
- `test_variable_types_network_error_raises_write_error`
- `test_list_variable_types_api_error`

## Variable type push strict/non-strict behavior

Python `push_variable_types(..., strict=False)` updates reusable type schemas by default, but checks
existing variable labels that reference an updated type. If existing labels no longer validate
against the new schema, non-strict mode prints warnings and still applies the type update.

With `strict=True`, the same incompatible labels block the type update and return `False` before
mutation. Dry-run is handled after this blocking gate, so `dry_run=True` does not bypass strict
type-label incompatibility.

For no-op type pushes, JS should use its structured result shape instead of Python's CLI boolean:
return `blocked: false`, `blockedBy: []`, `changes: []`, and the requested `dryRun` value.

Required JS work:

1. Add `strict?: boolean` to `variablesPushTypes()`, defaulting to `false`.
2. When updating a type schema, fetch variable config and find variables with matching `type_name`.
3. Validate their existing labels and latest versions against the new type schema.
4. In non-strict mode, emit `console.warn()` and apply the type update.
5. In strict mode, return `blocked: true` with `blockedBy: ['incompatible_type_labels']` and do
   not mutate type schemas.
6. For no-op pushes, return `blocked: false`, `blockedBy: []`, `changes: []`, and `dryRun`.
7. Keep provider list/upsert failures as thrown operational errors, preferably `VariableWriteError`.
8. If the compatibility check cannot fetch current variable config, warn and continue, matching
   Python.

## Tests to add in JS

Recommended JS test grouping:

1. `composition.test.ts`
   - strict vs non-strict unresolved refs
   - soft vs fatal metadata
   - missing refs in blocks
   - dotted refs and helper args
   - malformed templates and reserved names
   - deep JSON traversal
   - escape parity
2. `vars.test.ts`
   - provider strict composition fallback
   - code default composition
   - callable default caching
   - context override composition
   - referenced override propagation
   - default failure warnings/reasons
3. `templateValidation.test.ts`
   - `TemplateFieldIssue` shape
   - root vs found-in variable attribution
   - per-root dedup
   - latest/code default/server label/ref-following cases
4. `templateVariable.test.ts` or existing `templateValidation.test.ts`
   - render-time mismatch policy
   - per-variable vs instance-level precedence
   - `TemplateInputsMismatchError` bypasses fallback
5. `remoteProvider.test.ts` or existing `vars.test.ts`
   - isolated snapshots
   - SSE clean-close backoff
   - list variable types network error wrapping

## Suggested implementation sequence

### Phase 0: Parser/tokenizer gate

Goal: de-risk the hardest part first: native-`@{...}@` composition parsing and mixed runtime
Handlebars preservation.

Tasks:

1. Build the tokenizer-based delimiter adapter.
2. Protect runtime `{{...}}`, triple, and quad delimiters while converting only composition
   `@{...}@` tags for parsing.
3. Move dependency extraction to Handlebars AST on the adapted composition template.
4. Cover helper args, subexpressions, dotted refs, block headers, parent refs, escaping,
   malformed syntax, deep structures, and sentinel collisions.
5. Stop with the failing parity case before adding a dependency or fork if the adapter cannot
   match Python.

Validation gate:

- parser-focused Python parity tests ported to JS
- `vp run logfire#test -- vars -t "reference|composition|template"` or nearest focused filter

### Phase 1: Runtime semantics

Goal: make `get()` behavior match Python for provider values, defaults, and overrides.

Tasks:

1. Add `fatal` to `ComposedReference`.
2. Add `strict` composition option.
3. Refactor `Variable.resolve()` around a shared:
   lookup serialized -> compose -> optional render -> deserialize attempt.
4. Add code-default composition with strict/non-strict retry.
5. Add callable default result caching per `get()`.
6. Add context override composition.

Validation gate:

- `vp run logfire#test -- vars`
- `vp run logfire#typecheck`

### Phase 2: Template mismatch policy

Goal: make `TemplateVariable.get()` match Python's `warn` / `error` / `ignore` behavior.

Tasks:

1. Add exported policy type and error class.
2. Add variable-level and runtime-level options.
3. Reuse or upgrade `extractTemplatePaths()` for render-time checking.
4. Add warning behavior.
5. Ensure policy `error` throws instead of falling back.

Validation gate:

- focused template variable tests
- `vp run logfire#test -- vars`
- `vp run logfire#typecheck`

### Phase 3: Push/validate graph parity

Goal: make `variablesValidate()` and `variablesPush()` report and enforce the same issues as
Python.

Tasks:

1. Add `findReferencesAndErrors()`.
2. Add graph-wide reference checker.
3. Add `TemplateFieldIssue` and composition-aware template field validator.
4. Follow `LabelRef`s for template validation.
5. Change strict/non-strict push behavior, with cycles always blocking.
6. Keep `VariablePushResult` small: use `blocked` / `blockedBy` for blocked gates, and leave full
   structured diagnostics in `variablesValidate()`.

Validation gate:

- push/validate focused tests
- `vp run logfire#test -- vars`
- `vp run logfire#typecheck`

### Phase 4: Provider hardening and docs

Goal: complete non-runtime parity and make the API understandable.

Tasks:

1. Snapshot clone provider configs.
2. Fix SSE backoff reset timing.
3. Wrap variable-type list network errors.
4. Update docs/examples for:
   - `@{...}@` composition semantics
   - missing reference behavior
   - template mismatch policy
   - push strict/non-strict behavior
5. Add a changeset if this branch will ship as package-visible behavior.

Validation gate:

- provider focused tests
- `vp run logfire#test -- vars`
- `vp run logfire#typecheck`
- `pnpm run build` if public exports changed

## Resolved API decisions

1. JS warnings use `console.warn()`. No warning callback or warning array is added in this PRP.
2. JS changes unresolved-reference behavior to match Python: strict provider/override values fall
   back, and lenient code defaults render unresolved refs empty with a warning.
3. `ValidationReport` uses the clean Python-parity shape with JS camelCase names. Do not keep
   `referenceWarnings` or `templateInputWarnings` aliases.
4. Parser strategy is a tokenizer-based delimiter adapter plus Handlebars AST traversal. Do not add
   `handlebars-delimiters`; if parity fails, stop with the failing case before adding a dependency
   or fork.
5. `variablesPush()` and `variablesPushTypes()` keep small result objects. Non-strict warnings use
   `console.warn()`, full structured diagnostics stay in `variablesValidate()`, and blocked
   validation gates use `blocked` / `blockedBy`.

## Minimum acceptance criteria for equivalence

The JS implementation should be considered equivalent to Python PR #1954 only after:

1. Provider values with missing composition refs fall back to code default.
2. Code defaults with missing composition refs render the missing refs empty after a warning.
3. Serializable overrides participate in composition and template rendering.
4. Referenced variable overrides are visible through parent composition.
5. Cycle/depth failures are explicit `fatal` composition errors.
6. `TemplateVariable.get()` enforces `warn` / `error` / `ignore` mismatch policy.
7. `variablesValidate()` exposes reference errors, reference cycles, and template field issues.
8. `variablesPush(strict: false)` blocks cycles but allows missing refs/template issues with
   visible warnings.
9. `variablesPush(strict: true)` blocks missing refs, cycles, template field issues, and label
   incompatibilities.
10. Template field issues identify root variable, found-in variable, found-in label, and
    composition path.
11. Validation follows server-only composition chains and label refs.
12. Parser behavior covers the Python tests for block helpers, dotted refs, helper args,
    escaping, malformed templates, and deep structures.
13. Remote/local provider config snapshots cannot be mutated by callers.
14. The JS public API exports the new policy/error types and includes docs/tests.
