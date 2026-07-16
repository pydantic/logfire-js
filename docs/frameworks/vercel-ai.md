---
title: Vercel AI SDK
description: Capture Vercel AI SDK OpenTelemetry spans in Logfire from Node.js and Next.js applications.
---

# Vercel AI SDK

The Vercel AI SDK can emit OpenTelemetry spans for model calls, tools, token usage, and streaming operations. Logfire can receive those spans through either `@pydantic/logfire-node` in Node.js scripts or `@vercel/otel` in Next.js applications.

Since **AI SDK v7**, the recommended telemetry path is the [`@ai-sdk/otel`](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) package, which emits spans that follow the OpenTelemetry GenAI semantic conventions (`gen_ai.*`). **AI SDK v6 and earlier** used the per-call `experimental_telemetry` option and the legacy `ai.*` attribute shape. Logfire recognizes both, so existing instrumentation keeps working — the sections below cover each path.

## Node.js Scripts (AI SDK v7)

```bash
npm install @pydantic/logfire-node ai @ai-sdk/otel @ai-sdk/openai
```

Replace `@ai-sdk/openai` with the provider package you use, such as `@ai-sdk/anthropic` or `@ai-sdk/google`.

Configure Logfire before importing the AI SDK:

```ts title="instrumentation.ts"
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'ai-worker',
})
```

Register the `@ai-sdk/otel` integration once at startup. After that, every AI SDK call emits telemetry — you do not set `experimental_telemetry` per call:

```ts
import './instrumentation.ts'
import { OpenTelemetry } from '@ai-sdk/otel'
import { openai } from '@ai-sdk/openai'
import { generateText, registerTelemetry } from 'ai'

// Register once for the whole process.
registerTelemetry(new OpenTelemetry())

const result = await generateText({
  model: openai('gpt-4.1-mini'),
  prompt: 'Write a short haiku about traces.',
})

console.log(result.text)
```

`@ai-sdk/otel` exports two integrations:

- `OpenTelemetry` — emits GenAI semantic-convention spans (`gen_ai.*`). Recommended, and what Logfire renders and prices best.
- `LegacyOpenTelemetry` — emits the older AI SDK (`ai.*`) span shape for tools that have not migrated.

## Next.js

In Next.js, configure `@vercel/otel` as shown in [Next.js](nextjs.md), then register `@ai-sdk/otel` in the same `instrumentation.ts`. The `instrumentation.ts` file must live in the project root, or in `src` if your Next.js app uses `src`.

```bash
npm install @vercel/otel @opentelemetry/api ai @ai-sdk/otel @ai-sdk/openai
```

## Legacy Telemetry (AI SDK v6 and earlier)

Before v7, the Vercel AI SDK emitted spans only when `experimental_telemetry.isEnabled` was set on each call:

```ts
const result = await generateText({
  model,
  prompt: 'Write a short haiku about traces.',
  experimental_telemetry: { isEnabled: true },
})
```

This still works and covers the AI SDK core functions that emit telemetry, including:

- `generateText` and `streamText`
- `generateObject` and `streamObject`
- `embed` and `embedMany`

These calls produce the legacy `ai.*` attribute shape (for example `ai.model.provider`, `ai.response.model`, `ai.usage.promptTokens`). Logfire maps both the legacy `ai.*` attributes and the v7 `gen_ai.*` attributes, so spans from either version are recognized as LLM spans.

## Example: Text Generation With Tools

```ts
import './instrumentation.ts'
import { OpenTelemetry } from '@ai-sdk/otel'
import { openai } from '@ai-sdk/openai'
import { generateText, registerTelemetry, tool } from 'ai'
import { z } from 'zod'

registerTelemetry(new OpenTelemetry())

const result = await generateText({
  model: openai('gpt-4.1-mini'),
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

When telemetry is enabled, Logfire captures a trace for each AI operation. With `@ai-sdk/otel` (v7), **span names include the model name**, so a single `generateText` call with a tool produces spans such as:

- `invoke_agent gpt-4.1-mini` — the root agent span
- `chat gpt-4.1-mini` — the provider/model call
- `execute_tool weather` — a tool call

Depending on the AI SDK provider and call type, traces can also include:

- model and provider details (`gen_ai.provider.name`, `gen_ai.request.model` / `gen_ai.response.model`)
- input and output token usage
- timing information
- tool call arguments and results
- prompts and responses (`gen_ai.input.messages` / `gen_ai.output.messages`) when the AI SDK emits them

Prompts and responses may contain sensitive data. To emit telemetry without recording inputs or outputs for a v7 call, set both options to `false`:

```ts
await generateText({
  model,
  prompt,
  telemetry: {
    recordInputs: false,
    recordOutputs: false,
  },
})
```

Set `telemetry.isEnabled` to `false` to disable telemetry entirely for an individual call.

## Metadata

Use `functionId` and `metadata` to make traces easier to query. In v7, pass them through the per-call `telemetry` option:

```ts
await generateText({
  model,
  prompt,
  telemetry: {
    functionId: 'support-reply',
    metadata: {
      tenant: 'acme',
    },
  },
})
```

`functionId` identifies the agent or use case behind a call. Logfire uses it as the agent identity when grouping runs (for example on the AI Engineering agent pages), rather than it only appearing in span names — in v7 the span name carries the model, not the `functionId`. `metadata` attaches custom key-value pairs to the emitted telemetry spans.

For AI SDK v6 and earlier, pass the same fields inside `experimental_telemetry`:

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
