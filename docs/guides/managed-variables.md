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

## Baggage Context

Resolved variables can attach their selected label to OpenTelemetry baggage:

```ts
await resolved.withContext(async () => {
  logfire.info('checkout copy selected')
})
```

See `examples/node/variables.ts` for a complete local and remote example.
