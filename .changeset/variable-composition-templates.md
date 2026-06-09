---
'logfire': minor
---

Add managed variable composition and template rendering to `logfire/vars`.

Variables can now reference other variables with `@{name}@`, expose composition metadata on resolved values, render `{{}}` placeholders through `ResolvedVariable.render()`, and use the new `defineTemplateVar()` / `templateVar` API for compose-and-render prompt/config values. Variable configs also support `template_inputs_schema`, `templateMismatchPolicy`, structured validation diagnostics, strict/non-strict push blocking results, context override composition, and Python-parity fallback behavior for provider values and code defaults.
