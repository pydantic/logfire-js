---
'logfire': minor
---

Add managed variable composition and template rendering to `logfire/vars`.

Variables can now reference other variables with `@{name}@`, expose composition metadata on resolved values, render `{{}}` placeholders through `ResolvedVariable.render()`, and use the new `defineTemplateVar()` / `templateVar` API for compose-and-render prompt/config values. Variable configs also support `template_inputs_schema` for validation and strict push checks.
