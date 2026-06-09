---
title: Managed Variables
description: Use logfire/vars and @pydantic/logfire-node/vars for local and remote managed variables.
---

# Managed Variables

Managed variables let code resolve runtime configuration from local config or the Logfire Variables API.

Use `@pydantic/logfire-node/vars` in Node.js projects and `logfire/vars` in runtime-agnostic code.

## Local Variables

```ts
import * as logfire from '@pydantic/logfire-node'
import { defineVar } from '@pydantic/logfire-node/vars'

logfire.configure({
  serviceName: 'checkout-api',
  variables: {
    config: {
      variables: {
        checkout_button_copy: {
          labels: {
            control: { serialized_value: '"Start trial"', version: 1 },
          },
          name: 'checkout_button_copy',
          overrides: [],
          rollout: { labels: { control: 1 } },
        },
      },
    },
  },
})

const checkoutButtonCopy = defineVar('checkout_button_copy', {
  default: 'Continue',
})

const resolved = await checkoutButtonCopy.get({
  targetingKey: 'user_123',
})
```

## Remote Variables

Remote variables require a Logfire API key:

```ts
logfire.configure({
  apiKey: process.env.LOGFIRE_API_KEY,
  serviceName: 'checkout-api',
  variables: {
    blockBeforeFirstResolve: true,
    polling: false,
  },
})
```

Do not expose API keys in browser bundles. Browser apps should use local variables or resolve variables through a trusted backend.

## Composition And Templates

String values can reference other variables with `@{variable_name}@`. Composition runs before the value is parsed by the variable codec, so references can be used inside JSON strings, objects, and arrays. Dotted paths and Handlebars block helpers are supported:

```ts
import { defineTemplateVar } from '@pydantic/logfire-node/vars'

const checkoutPrompt = defineTemplateVar<string, { customerName: string }>('checkout_prompt', {
  default: 'Say hello to {{customerName}}.',
  templateInputsSchema: {
    properties: { customerName: { type: 'string' } },
    required: ['customerName'],
    type: 'object',
  },
})

const resolved = await checkoutPrompt.get({ customerName: 'Ada' })
```

A remote or local value such as `"Use @{brand_voice}@. Customer: {{customerName}}"` first expands `@{brand_voice}@`, then `defineTemplateVar().get()` renders the remaining `{{customerName}}` placeholder.

Provider values compose strictly. If a selected provider value has an unresolved reference, a cycle, or an invalid referenced value, resolution falls back to the variable's code default. Code defaults also compose; if a code default has unresolved non-fatal references, those references render as empty strings and a warning is emitted.

Serializable context overrides participate in composition. Overrides that cannot be serialized through the variable codec are returned verbatim for the top-level variable and are skipped with a warning when referenced from another variable.

Use `\@{name}@` for a literal `@{name}@`.

`templateInputsSchema` is explicit in JavaScript because TypeScript types are not available at runtime. It is used to check that composed template strings only reference declared `{{field}}` paths. The default `templateMismatchPolicy` is `warn`; use `error` to throw `TemplateInputsMismatchError` or `ignore` to render silently:

```ts
logfire.configure({
  variables: {
    config: { variables: {} },
    templateMismatchPolicy: 'error',
  },
})

const prompt = defineTemplateVar<string, { customerName: string }>('checkout_prompt', {
  default: 'Hello {{customerName}}',
  templateInputsSchema: {
    properties: { customerName: { type: 'string' } },
    type: 'object',
  },
  templateMismatchPolicy: 'warn',
})
```

`variablesValidate()` returns structured `referenceErrors`, `referenceCycles`, and `templateFieldIssues`. `variablesPush()` defaults to non-strict mode: reference cycles block, while missing references, template field issues, and incompatible labels warn and apply. Pass `{ strict: true }` to block on those issues and receive `{ blocked: true, blockedBy, changes, dryRun }` without mutating the provider.

## Baggage Context

Resolved variables can attach their selected label to OpenTelemetry baggage:

```ts
await resolved.withContext(async () => {
  logfire.info('checkout copy selected')
})
```

See `examples/node/variables.ts` for a complete local and remote example.
