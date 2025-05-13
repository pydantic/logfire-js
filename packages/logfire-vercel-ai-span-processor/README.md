# Pydantic Logfire — Uncomplicated Observability — JavaScript SDK

From the team behind [Pydantic](https://pydantic.dev/), **Logfire** is an observability platform built on the same belief as our
open source library — that the most powerful tools can be easy to use.

Check the [Github Repository README](https://github.com/pydantic/logfire-js) for more information on how to use the SDK.

---

## Integrating with @vercel/otel for Vercel AI Observability

To gain deep, actionable insights into how your application interacts with the [Vercel AI SDK](https://ai-sdk.dev/), you can seamlessly integrate Logfire's span processor with your OpenTelemetry setup. This enables advanced tracing, analytics, and detailed panels for every AI action within Logfire.

Add the Logfire Vercel AI Span Processor to your span processors when registering OpenTelemetry in your application:

```ts
import { registerOTel } from '@vercel/otel';
import { LogfireVercelAISpanProcessor } from '@pydantic/logfire-vercel-ai-span-processor';

registerOTel({
  serviceName: 'your-service-name',
  autoDetectResources: true,
  spanProcessors: [new LogfireVercelAISpanProcessor()],
});
```

By including the Logfire span processor, your Vercel AI spans will be automatically enriched with Logfire-compatible attributes. This integration empowers you to:
- Visualize and analyze each AI action in detail
- Monitor and debug AI workflows with precision
- Unlock advanced observability and reporting features in Logfire
