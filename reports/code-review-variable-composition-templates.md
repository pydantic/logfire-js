# Code Review — Variable Composition Templates

**Branch:** `petyosi/variable-composition-templates` → `main`
**Files changed:** 21 files (+2246 / −42)
**Date:** 2026-06-09
**Method:** 8 independent review dimensions fanned out, every candidate finding adversarially verified by a 3-lens panel (empirical reproduce / CLAUDE.md-specificity / git-history + Python-parity intent), followed by a completeness critic. Findings below survived ≥2 "real" votes with average confidence ≥70 and no intentional/pre-existing veto.

## Summary

| #   | Finding                                                                                         | Location                                     | Severity | Confidence |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | -------- | ---------- |
| 1   | Nested same-helper block references compose to a broken template, silently fall back to default | `composition.ts:7`                           | medium   | 72         |
| 2   | `toContain` on a fully deterministic error string                                               | `composition.test.ts:191`                    | low      | 75         |
| 3   | Fuzzy `arrayContaining` / `objectContaining` where the result is deterministic                  | `templateValidation.test.ts:120-124`, `:149` | low      | 70         |

Plus a broader test-assertion style cluster (below the confidence bar), one out-of-scope pre-existing security issue (ReDoS), and a set of adversarially-refuted candidates documented for the record.

---

## Issues Found

### 1. Nested same-helper block references compose to a broken template and silently fall back to default (Score: 72, medium)

- **Location:** `packages/logfire-api/src/vars/composition.ts:7` (`BLOCK_WITH_BODY_REF`), consumed in `protectUnresolvedReferences` (`:280`) and `collectResolvedBlockRanges` (`:299`).
- **Reason:** Bug — empirically reproduced.

The block-protection regex uses a lazy body with a `\1` backreference:

```ts
const BLOCK_WITH_BODY_REF = /(?<!\\)@\{#(\w+)\s+([a-zA-Z_][a-zA-Z0-9_]*)(.*?)\}@[\s\S]*?(?<!\\)@\{\/\1\}@/g
```

A single regex cannot balance two nested blocks that share a helper name (`each` / `if` / `with` / `unless`). When an outer block resolves but a same-helper inner block does **not**, the lazy `[\s\S]*?` closes the outer block at the _inner_ `@{/…}@`. The inner block is therefore never protected, and after `@{…}@` → `{{…}}` conversion the Handlebars template is unbalanced.

**Empirically captured runtime behavior:**

```
VariableCompositionError: Failed to render composed variable: Parse error on line 1:
... data {{/each}} end {{/each}}  —  Expecting 'EOF', got 'OPEN_ENDBLOCK'
```

This error is caught in `Variable.resolve()` (`index.ts:871`) and degrades **gracefully**: the variable returns its code default with `reason: 'other_error'` and the exception recorded. There is **no silent data corruption**, but a valid and common template shape (nested `if` / `each` with partial resolution) silently loses its composed value. There is no test for nested same-name blocks.

- **Repro input:** `@{#each outer}@ start @{#each inner}@ data @{/each}@ end @{/each}@` with `outer` resolved and `inner` unresolved.
- **Note:** When _both_ blocks resolve, the template comes out balanced and renders correctly. The defect is specific to the partial-resolution case.

**Suggested fix:** A regex cannot delimit a recursively-nestable structure correctly. Either:

- (a) Replace the block-protection pass with a stack-based scanner that matches open/close tags by helper name and nesting depth, protecting a block only when its variable is unresolved; or
- (b) If nested same-name blocks are explicitly out of scope to match the Python SDK, add a regression test that pins the graceful-fallback behavior so the limitation is intentional and documented:

```ts
it('falls back to default for nested same-helper blocks with partial resolution', async () => {
  const result = await expandReferences(
    JSON.stringify('@{#each outer}@a@{#each inner}@b@{/each}@c@{/each}@'),
    resolver({ outer: resolved('[1]') }) // inner unresolved
  )
  // document: composition cannot balance nested same-name blocks; caller falls back to default
  expect(JSON.parse(result.serializedValue)).toBe('@{#each outer}@a@{#each inner}@b@{/each}@c@{/each}@')
})
```

---

### 2. `toContain` on a fully deterministic error string (Score: 75)

- **Location:** `packages/logfire-api/src/vars/composition.test.ts:191`
- **Reason:** `AGENTS.md` Testing Guidance specifically names this: _"Use `toBe` or `toEqual` … instead of `toContain` or broad regex matching."_

The cycle error is built deterministically by `formatCompositionError` (`` `${error.name}: ${error.message}` ``), so the whole string is stable.

```ts
expect(result.composedFrom[0]?.composedFrom?.[0]?.error).toContain('VariableCompositionCycleError')
```

**Suggested fix:**

```ts
expect(result.composedFrom[0]?.composedFrom?.[0]?.error).toBe('VariableCompositionCycleError: Circular variable reference: a -> b -> a')
```

> The sibling `toContain('non-JSON')` at `composition.test.ts:176` was **not** flagged — its error tail is V8's engine-specific `JSON.parse` message, so matching a stable substring there is defensible.

---

### 3. Fuzzy `arrayContaining` / `objectContaining` where the result is deterministic (Score: 70)

- **Location:** `packages/logfire-api/src/vars/templateValidation.test.ts:120-124` (and `:149`, `.rejects.toThrow('template input schemas')`, a substring match).
- **Reason:** Same Testing-Guidance rule against fuzzy matching. The `referenceWarnings` array is fully determined by the fixed config (V8 preserves insertion order), and each entry's `message` is code-controlled but omitted from the match.

```ts
expect(report.referenceWarnings).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ reference: 'missing', type: 'missing_reference', variableName: 'prompt' }),
    expect.objectContaining({ reference: 'cyclic', type: 'composition_cycle', variableName: 'cyclic' }),
  ])
)
```

**Suggested fix:** Assert the complete array with exact objects (sort first if order isn't guaranteed), including the `message` field; and use the exact full message in `toThrow` at `:149`.

---

## Secondary: broader test-assertion style (cluster, ~score 50)

Several `toMatchObject(...)` assertions on deterministic structures match only a subset and could be exact `toEqual`:

- `composition.test.ts:53, 67, 110, 113, 116, 131, 134, 157`
- `template.test.ts:101, 120, 130, 144`

`toMatchObject` is **not** specifically named in `AGENTS.md` (which names `toContain` / regex), so these don't clear the confidence bar individually. Tightening them to `toEqual` would align with the stated preference for exact assertions and is worth a pass while in these files.

---

## Out of scope — pre-existing, not introduced by this branch (non-blocking)

### ReDoS via server-controlled `condition.pattern`

- **Location:** `packages/logfire-api/src/vars/index.ts:1684` and `:1694`

```ts
return typeof value !== 'string' || !new RegExp(condition.pattern, 'u').test(value)
return typeof value === 'string' && new RegExp(condition.pattern, 'u').test(value)
```

`condition.pattern` comes from the remote config and `value` can come from OTel baggage (default `includeBaggageInContext: true`). A planted pattern like `(a+)+$` against a ~28-char non-matching input blocks the event loop ~2.4 s (empirically measured; exponential growth):

| input length (`a`×n + `b`) | time    |
| -------------------------- | ------- |
| 22                         | 36 ms   |
| 25                         | 291 ms  |
| 28                         | 2386 ms |

`git blame` traces these lines to `585db46` / `#112` (original managed-variables PRs) — **not part of this diff**, so it is not a blocker for this PR. Recommended as a separate hardening change: compile/validate condition patterns once at `normalizeCondition` time and reject pathological ones, or use a linear-time regex engine.

---

## Adversarially verified clean

These candidates were investigated and **refuted** with concrete traces/tests:

- **Handlebars template injection / prototype pollution** — Handlebars 4.7.9 blocks `constructor.constructor`, `__proto__`, and `#with __proto__`; context values are `SafeString`-wrapped so they are not re-evaluated as templates. No exploit.
- **ReDoS in the new composition regexes** (`BLOCK_WITH_BODY_REF`, `REFERENCE_TAG`) — lazy quantifiers are anchored by unambiguous terminators; 10k-char pathological inputs complete in <10 ms.
- **SSE / timer resource handling** — `reader.releaseLock()` is in a `finally` block; `shutdown()` abort and the `started` guard are race-free; background rejections are contained by `ignoreBackgroundError`.
- **Unhandled rejections** — `expandValue` / `expandString` `Promise.all` rejections are caught by `Variable.resolve()`'s outer try/catch and converted to a default fallback.
- **Sentinel collisions** (`renderOnce`, `protectUnresolvedReferences`) — monotonic counter + CSPRNG `Math.random`; codepoint hex round-trip verified including the supplemental plane.
- **`composed_from` flattening & `reason` enum** — confirmed _intentional_ and matching the Python SDK (`commit c493bca` + `instrumentation.test.ts:70`).

### Low-severity note (no action required)

`ComposedReference.value` is JSON-serialized in JS (`"Hello"`) versus a bare string in Python (`Hello`). Because `value` is excluded from `toComposedFromAttribute`, there is no wire impact on the span attribute; the field is internally consistent and tested accordingly in JS.

---

## Verdict

One genuine (gracefully-degrading) correctness limitation worth a fix-or-document decision (#1), plus a few test-assertion tightenings (#2, #3). The composition engine's escaping, cycle/depth detection, and async failure handling are solid.
