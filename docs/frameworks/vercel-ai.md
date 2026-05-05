---
title: Vercel AI SDK
description: Capture Vercel AI SDK OpenTelemetry spans in Logfire from Node.js and Next.js applications.
---

# Vercel AI SDK

The Vercel AI SDK can emit OpenTelemetry spans for model calls, tools, token usage, and streaming operations. Logfire can receive those spans through either `@pydantic/logfire-node` in Node.js scripts or `@vercel/otel` in Next.js applications.

## Node.js Scripts

```bash
npm install @pydantic/logfire-node ai @ai-sdk/openai
```

Configure Logfire before importing the AI SDK:

```ts title="instrumentation.ts"
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'ai-worker',
})
```

Enable telemetry on AI SDK calls:

```ts
import './instrumentation.ts'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

const result = await generateText({
  model: openai('gpt-4.1-mini'),
  prompt: 'Write a short haiku about traces.',
  experimental_telemetry: { isEnabled: true },
})

console.log(result.text)
```

## Next.js

In Next.js, configure `@vercel/otel` as shown in [Next.js](nextjs.md), then enable the same `experimental_telemetry` option on AI SDK calls.

## Metadata

Use `functionId` and `metadata` to make traces easier to query:

```ts
await generateText({
  model,
  prompt,
  experimental_telemetry: {
    functionId: 'support-reply',
    isEnabled: true,
    metadata: {
      tenant: 'acme',
    },
  },
})
```
