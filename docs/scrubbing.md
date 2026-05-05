---
title: Scrubbing
description: Scrub sensitive data from Logfire TypeScript SDK span attributes before export.
---

# Scrubbing

The TypeScript SDK scrubs sensitive-looking attribute values before export. Scrubbing applies to manual span attributes and to data processed through the Logfire API helpers.

## Add Patterns

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  scrubbing: {
    extraPatterns: ['secret_token', 'internal_customer_note'],
  },
  serviceName: 'checkout-api',
})
```

## Disable Scrubbing

Disable scrubbing only when you are certain telemetry cannot contain sensitive data:

```ts
logfire.configure({
  scrubbing: false,
  serviceName: 'local-test',
})
```

## Custom Callback

Use a callback for application-specific handling:

```ts
logfire.configure({
  scrubbing: {
    callback: (match) => {
      if (match.path.includes('debug')) return match.value
      return '[scrubbed]'
    },
  },
  serviceName: 'checkout-api',
})
```

Prefer not to attach secrets to span attributes in the first place. Scrubbing is a backstop, not a replacement for careful telemetry design.
