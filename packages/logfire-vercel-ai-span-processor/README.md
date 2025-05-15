

## Pydantic Logfire Vercel AI Otel Span Processor

With the help of `LogfireVercelAISpanProcessor`, you can monitor and observe the [Vercel AI SDK](https://ai-sdk.dev/) behavior on the runtime.

<img width="1394" alt="Logfire UI with Vercel AI SDK traces" src="https://github.com/user-attachments/assets/50568c94-3955-46d3-a9c9-5d82c888ddcc" />

Add the Logfire Vercel AI Span Processor to your span processors when registering OpenTelemetry in your application:

```bash
npm install @pydantic/logfire-vercel-ai-span-processor`
```

```ts
// instrumentation.ts
import { registerOTel } from '@vercel/otel';
import { LogfireVercelAISpanProcessor } from '@pydantic/logfire-vercel-ai-span-processor';

registerOTel({
  serviceName: 'your-service-name',
  autoDetectResources: true,
  spanProcessors: [new LogfireVercelAISpanProcessor()],
});
```

## Pydantic Logfire — Uncomplicated Observability — JavaScript SDK

From the team behind [Pydantic](https://pydantic.dev/), **Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

Check the [Github Repository README](https://github.com/pydantic/logfire-js) for more information on how to use the SDK.
