/**
 * Shared test scaffolding: a local variables provider, a stub model, and a way to see what warned.
 *
 * Everything here is offline. The Logfire SDK's `LocalVariableProvider` reads, creates, and updates
 * an in-memory config, so the publish path is exercised against the same interface the remote
 * provider implements; the model is `MockLanguageModelV4` from `ai/test`, which is the AI SDK's own
 * stub and records every call it was made with.
 */

import { configureVariables } from '@pydantic/logfire-node/vars'
import type { VariableConfig, VariablesConfig } from '@pydantic/logfire-node/vars'
import type {
  LanguageModelV3,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, vi } from 'vitest'

// A test that has to assert "warns once per process" needs a process that has not warned yet, and one
// that asserts a baseline was published needs a process that has not published yet. The core ships
// both resets from a subpath of its own, so this adapter shares the core's single dedup set rather
// than keeping a second one beside it.
import { resetAgentControl } from '@pydantic/logfire-node/agent-control/testing'

/** A variables config in which `name` holds `value` under one label at full rollout. */
export function publishedValue(name: string, value: unknown, label = 'production'): VariablesConfig {
  return {
    variables: {
      [name]: {
        name,
        labels: { [label]: { version: 1, serialized_value: JSON.stringify(value) } },
        rollout: { labels: { [label]: 1 } },
        overrides: [],
      },
    },
  }
}

/** Point the SDK at a local provider holding `config`. */
export function useLocalVariables(config: VariablesConfig = { variables: {} }): void {
  configureVariables({ config, instrument: false })
}

/** Switch variables off entirely, which is what an application with no Logfire token gets. */
export function useNoVariables(): void {
  configureVariables(false)
}

/** Read a variable's stored definition back out of the local provider. */
export async function storedConfig(name: string): Promise<VariableConfig | undefined> {
  const { getVariableProvider } = await import('@pydantic/logfire-node/vars')
  return getVariableProvider().getVariableConfig?.(name) as VariableConfig | undefined
}

/** Capture `console.warn` for the duration of a test, and reset every once-per-process guard. */
export function captureWarnings(): { messages: string[] } {
  const captured: { messages: string[] } = { messages: [] }
  beforeEach(() => {
    captured.messages.length = 0
    resetAgentControl()
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      captured.messages.push(String(message))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useNoVariables()
  })
  return captured
}

/** Wait for the background baseline publish to settle. */
export async function settle(): Promise<void> {
  await Promise.all(Array.from({ length: 5 }, async () => Promise.resolve()))
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
  totalTokens: 2,
}

/** A finished generate result carrying one text part. */
export function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage,
    warnings: [],
  }
}

/** A generate result asking for one tool call, under the name the model was shown. */
export function toolCallResult(toolName: string, input: unknown): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage,
    warnings: [],
  }
}

/** A stream that asks for one tool call, in the parts a provider actually emits for one. */
export function toolCallStream(toolName: string, input: unknown): LanguageModelV4StreamResult {
  return streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'call-1', toolName },
    { type: 'tool-input-delta', id: 'call-1', delta: JSON.stringify(input) },
    { type: 'tool-input-end', id: 'call-1' },
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
  ])
}

/** A stream that emits one piece of text and finishes. */
export function textStream(text: string): LanguageModelV4StreamResult {
  return streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
  ])
}

function streamOf(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part)
        }
        controller.close()
      },
    }),
  }
}

/**
 * A pre-v4 model, which `wrapLanguageModel` accepts and bridges with a lying `Proxy`.
 *
 * `asLanguageModelV4` wraps a v2 or v3 model in a proxy whose only behavior is to answer `'v4'` to
 * `specificationVersion` and forward everything else, so the request such a provider is handed is a
 * v4 one and the one field v4 added -- `reasoning` -- reaches a provider with no contract for it.
 * Which is why this stub is a plain object rather than a `MockLanguageModelV4`: what matters is the
 * version it reports before it is wrapped.
 */
export function legacyModel(
  specificationVersion: 'v2' | 'v3',
  results: LanguageModelV4GenerateResult[] = []
): LanguageModelV3 & { calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = []
  return {
    specificationVersion,
    provider: 'legacy.chat',
    modelId: 'old-model',
    supportedUrls: {},
    calls,
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      calls.push(options)
      return Promise.resolve(results.shift() ?? textResult('done'))
    },
    doStream: async () => Promise.resolve(textStream('done')),
  } as unknown as LanguageModelV3 & { calls: LanguageModelV4CallOptions[] }
}

/** A model that answers with each of `results` in turn, and remembers what it was asked. */
export function stubModel(
  results: LanguageModelV4GenerateResult[] | LanguageModelV4StreamResult[],
  provider = 'anthropic.messages',
  modelId = 'claude-fable-5-1'
): MockLanguageModelV4 {
  const generates = results.filter((result): result is LanguageModelV4GenerateResult => 'content' in result)
  const streams = results.filter((result): result is LanguageModelV4StreamResult => 'stream' in result)
  return new MockLanguageModelV4({
    provider,
    modelId,
    // `MockLanguageModelV4` records the call options itself, on `doGenerateCalls` and
    // `doStreamCalls`, so these only have to answer.
    doGenerate: async () => Promise.resolve(generates.shift() ?? textResult('done')),
    doStream: async () => Promise.resolve(streams.shift() ?? textStream('done')),
  })
}
