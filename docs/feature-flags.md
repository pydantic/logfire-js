---
title: Feature Flags in Node.js
description: Define typed feature flags, target them per request, and evaluate them from cached configuration in Node.js.
---

Roll out a feature for selected accounts or change an agent's settings without redeploying. Define each flag in code with a value the application can use before you configure the flag in Logfire.

!!! note "Experimental"
The Node.js import path and API may change.

## Define a flag

```typescript
import { configure, shutdown } from '@pydantic/logfire-node'
import { defineFlag } from '@pydantic/logfire-node/experimental/feature-flags'

configure({ console: false, sendToLogfire: false, variables: false })

const newCheckout = defineFlag('new_checkout', { default: false })
console.log(await newCheckout.value()) // false

await shutdown()
```

To read remote configuration, create a project API key with the `project:read_variables` scope in **Project → Settings → API Keys**. Set `LOGFIRE_API_KEY` and remove `variables: false`. The SDK keeps a configuration snapshot in memory and updates it in the background. Evaluations use that snapshot after the first load. Enable telemetry with a write token from the same project if you also want to record decisions.

The first evaluation can wait for the initial configuration request. To serve the code default immediately while that request runs, configure `variables: { blockBeforeFirstResolve: false }`. For remote variables, `timeoutMs` defaults to 10,000 ms.

`details()` returns the value, the reason, and any variant, value version, or error code. A selected variant can use the code default and still count as an assignment to that variant. An invalid configured value returns the code default and reports an error. A failed refresh after a successful load can still serve the cached value with reason `stale`.

With telemetry enabled, Logfire records a `feature_flag.evaluation` span. A first-use declaration includes the available input schema and, for boolean flags, the code default. Schema defaults and examples are omitted. Keep flag names, descriptions, and schema constraints such as enum values safe to share. To start a rollout, create the flag and publish a value in Logfire.

## Validate structured values

Pass a synchronous [Standard Schema](https://standardschema.dev/) validator for a structured flag. Install `zod` to use this example.

```typescript
import { defineFlag } from '@pydantic/logfire-node/experimental/feature-flags'
import { z } from 'zod'

const assistantPolicy = defineFlag('assistant_policy', {
  default: { model: 'small', maxDocuments: 1 },
  schema: z.object({
    model: z.enum(['small', 'large']),
    maxDocuments: z.number().int().min(1).max(10),
  }),
})

const policy = await assistantPolicy.value()
console.log(policy.maxDocuments)
```

The default and overrides take the schema's input type. `value()` and `details()` return the validated output, which can differ when the schema transforms its input. Return plain objects, arrays, strings, finite numbers, booleans, or `null`. Configured references resolve from the same snapshot before validation. Defaults and overrides are literal values.

## Set targeting for one request

```typescript
import { defineFlag, withFeatureContext } from '@pydantic/logfire-node/experimental/feature-flags'

const newCheckout = defineFlag('new_checkout', { default: false })

const enabled = await withFeatureContext({ targetingKey: 'account-123', attributes: { plan: 'team' } }, async () => newCheckout.value())
```

Use a stable user or account ID for a consistent assignment across requests. Arguments to `value()` or `details()` take precedence over the current scope. An empty targeting key is treated as absent. Pass attributes through this API so your code chooses which request data can affect targeting.

Within a local recording trace or an explicit `withFeatureContext({}, callback)` scope, evaluations without a key share a locally generated anonymous key. If there is no scope or key, split rollouts return the code default with `targeting_key_missing`.

JavaScript and Python currently use different rollout algorithms. Evaluate a shared experiment through one evaluator, such as Logfire's OFREP endpoint, to keep assignments consistent across languages.

## Exercise both outcomes

```typescript
await newCheckout.override(true, async () => {
  console.log(await newCheckout.value()) // true
})
```

Overrides apply inside the callback and can be nested. They leave configuration and other requests alone.

## Use flags in a browser

Connect an [OpenFeature Web provider](https://openfeature.dev/docs/reference/other-technologies/ofrep/) to Logfire's OFREP endpoint. Use a project key scoped to `project:read_external_variables` and mark the intended flags external. Anyone who can read that browser key can read the project's external flags, so publish values suitable for a public client. Read the [browser setup guide](https://pydantic.dev/docs/logfire/manage/client-side-feature-flags/) for credential setup and signed-in context changes.

## Try the local example

From a built `logfire-js` checkout, run `pnpm --dir examples/node run feature-flags`. The example prints a typed policy composed from another configured value and the checkout preview before, during, and after a scoped override. It runs without credentials or network calls.
