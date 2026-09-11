---
title: Resource Attributes
description: Add stable OpenTelemetry resource attributes to Logfire TypeScript SDK telemetry.
---

# Resource Attributes

Resource attributes describe the entity producing telemetry. Use them for stable metadata such as service namespace, deployment metadata, or an application instance identifier.

## Node.js

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'checkout-api',
  resourceAttributes: {
    'service.namespace': 'payments',
    'service.instance.id': process.env.HOSTNAME,
  },
})
```

## Browser

Start with the `frontendApplicationConfig` generated under **Project settings > Frontend applications**. The frontend application owns `service.name`, `service.namespace`, and the optional environment, so browser code should add only other stable attributes:

```ts
import * as logfire from '@pydantic/logfire-browser'

const frontendApplicationConfig = {
  traceUrl: '<generated-regional-trace-url>',
  traceExporterHeaders: () => ({
    Authorization: 'Bearer <frontend-application-token>',
  }),
}

logfire.configure({
  ...frontendApplicationConfig,
  resourceAttributes: {
    'app.installation.id': installationId,
  },
})
```

## Precedence

First-class options such as `serviceName`, `serviceVersion`, and `environment` take precedence over conflicting resource attributes.

In Node.js, values from `OTEL_RESOURCE_ATTRIBUTES` are also read by the OpenTelemetry SDK and can override code-level values depending on SDK configuration.

Do not use resource attributes for per-request values, user identifiers, or secrets. Put request-specific data on spans as attributes instead.
