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

Replace `@ai-sdk/openai` with the provider package you use, such as `@ai-sdk/anthropic` or `@ai-sdk/google`.

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

In Next.js, configure `@vercel/otel` as shown in [Next.js](nextjs.md), then enable the same `experimental_telemetry` option on AI SDK calls. The `instrumentation.ts` file must live in the project root, or in `src` if your Next.js app uses `src`.

```bash
npm install @vercel/otel @opentelemetry/api ai @ai-sdk/openai
```

## Enabling Telemetry

The Vercel AI SDK emits OpenTelemetry spans when `experimental_telemetry.isEnabled` is set:

```ts
const result = await generateText({
  model,
  prompt: 'Write a short haiku about traces.',
  experimental_telemetry: { isEnabled: true },
})
```

This works with the AI SDK core functions that emit telemetry, including:

- `generateText` and `streamText`
- `generateObject` and `streamObject`
- `embed` and `embedMany`

## Example: Text Generation With Tools

```ts
import { openai } from '@ai-sdk/openai'
import { generateText, tool } from 'ai'
import { z } from 'zod'

const result = await generateText({
  model: openai('gpt-4.1-mini'),
  experimental_telemetry: { isEnabled: true },
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72,
      }),
    }),
  },
  prompt: 'What is the weather in San Francisco?',
})

console.log(result.text)
```

For Node.js scripts, import your Logfire instrumentation file before importing or calling the AI SDK.

## What You Will See

When telemetry is enabled, Logfire captures a trace for each AI operation. Depending on the AI SDK provider and call type, traces can include:

- parent spans such as `ai.generateText`
- provider call spans for the model request
- tool call spans
- model and provider details
- input and output token usage
- timing information
- tool call arguments and results
- prompts and responses when the AI SDK emits them

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

`functionId` appears in span names and helps distinguish use cases. `metadata` attaches custom key-value pairs to the emitted telemetry spans.
