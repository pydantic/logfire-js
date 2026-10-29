---
title: Scrubbing
description: Scrub sensitive data from Logfire TypeScript SDK span attributes before export.
---

# Scrubbing

The TypeScript SDK scrubs sensitive-looking attribute values before export. Scrubbing applies to every exported span, including spans from automatic instrumentation and attributes set after a span starts, and to span event attributes, span link attributes, and Node.js log records.

In the browser and in Cloudflare Workers, span processors you add yourself (`spanProcessors` and `additionalSpanProcessors`) run before this pass and receive unscrubbed spans.

Exception messages are scrubbed wherever they appear: the `exception.message` attribute, the exception event, the span status message, and the message and `Caused by` lines of `exception.stacktrace`. Stack frame lines are kept as they are. In the browser, `configureFrontend` removes query strings and fragments from URL attributes and from the URLs inside exception stack traces.

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

## Declare Safe Attribute Keys

Scrubbing checks values as well as keys, so a code-defined label such as `checkout_authenticated` is redacted because it contains `auth`. Declare the attribute keys your application sets from code-defined values to keep them intact:

```ts
logfire.configure({
  scrubbing: {
    safeKeyPrefixes: ['app.checkout.'],
    safeKeys: ['app.result'],
  },
  serviceName: 'checkout-api',
})
```

- `safeKeys` lists exact attribute keys.
- `safeKeyPrefixes` lists key prefixes. Include the trailing separator, so `app.checkout.` does not also match `app.checkout_token`. An empty prefix is rejected.

Neither the key nor the value of a matching attribute is scrubbed, and `extraPatterns` and `callback` do not apply to it. This covers top-level attributes on every exported span, including spans you create with the OpenTelemetry tracer directly, span event and span link attributes, Node.js log record attributes, and message template fields. Keys nested inside an object or array attribute value, the span status message, and log record bodies are still scrubbed. `@pydantic/logfire-node`, `@pydantic/logfire-browser`, and `@pydantic/logfire-cf-workers` accept these options, and the browser SDK keeps exempting its own session and URL attributes.

Declare only keys whose values your code controls. A declared key is sent as is, even if a value later carries user input.

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
