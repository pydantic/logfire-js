/**
 * Shared test scaffolding: a local variables provider, mock models, and unique agent names.
 *
 * Everything is offline. The Logfire SDK's `LocalVariableProvider` serves a published value from
 * memory through the same interface the remote one implements, and every model is a `MockLanguageModel`
 * from the AI SDK's own test kit, so a test asserts on the exact call Mastra would have made.
 */

import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import type { Agent } from '@mastra/core/agent'
import { configureVariables } from '@pydantic/logfire-node/vars'
import type { VariablesConfig } from '@pydantic/logfire-node/vars'
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, vi } from 'vite-plus/test'

import { resetAgentControl } from '@pydantic/logfire-node/agent-control/testing'

/**
 * A fresh agent name for each test.
 *
 * The core deduplicates its warnings, and publishes a baseline, once per process per variable.
 * `resetAgentControl` clears both between tests, but a name no other test uses is the belt to that
 * pair of braces: it keeps a test that forgets the reset -- or one that runs a second control inside
 * a single test -- from silently observing nothing and passing for the wrong reason.
 */
let counter = 0
export function nextAgentId(): string {
  counter += 1
  return `test_agent_${String(counter)}`
}

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

/** Publish `value` for `agentId` and point the SDK at it, which is what most tests want. */
export function useManagedAgent(agentId: string, value: unknown): void {
  useLocalVariables(publishedValue(`agent__${agentId}`, value))
}

/** Switch variables off entirely, which installs the no-op provider. */
export function useNoVariables(): void {
  configureVariables(false)
}

/** Capture `console.warn` for the duration of a test. */
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
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as unknown as LanguageModelV3GenerateResult['usage']

/** One `doGenerate` result: a plain text answer. */
export function text(value = 'ok'): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text: value }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  }
}

/** One `doGenerate` result: a call to `toolName` with `input`. */
export function toolCall(toolName: string, input: Record<string, unknown>): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: 'call_1', toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: USAGE,
    warnings: [],
  }
}

/**
 * A v3 mock model that answers with `results` in order, repeating the last one.
 *
 * Both call methods answer, because Mastra uses one for `generate` and the other for `stream` and an
 * adapter that sits at the model boundary has to sit at both of them. The streamed form is the
 * generated one taken apart into the parts a provider would have sent.
 */
export function mockModel(
  provider = 'mock',
  modelId = 'mock-model',
  results: LanguageModelV3GenerateResult[] = [text()]
): MockLanguageModelV3 {
  let index = 0
  const next = (): LanguageModelV3GenerateResult => results[Math.min(index++, results.length - 1)] as never
  return new MockLanguageModelV3({
    provider,
    modelId,
    doGenerate: async () => Promise.resolve(next()),
    doStream: () => Promise.resolve({ stream: streamOf(next()) }) as never,
  })
}

/** One generated answer as the stream of parts a provider would have sent for it. */
function streamOf(result: LanguageModelV3GenerateResult): ReadableStream<unknown> {
  const parts: unknown[] = [{ type: 'stream-start', warnings: [] }]
  for (const [n, part] of result.content.entries()) {
    if (part.type === 'tool-call') {
      parts.push(
        { type: 'tool-input-start', id: part.toolCallId, toolName: part.toolName },
        { type: 'tool-input-delta', id: part.toolCallId, delta: part.input },
        { type: 'tool-input-end', id: part.toolCallId },
        part
      )
    } else if (part.type === 'text') {
      parts.push(
        { type: 'text-start', id: `msg_${String(n)}` },
        { type: 'text-delta', id: `msg_${String(n)}`, delta: part.text },
        { type: 'text-end', id: `msg_${String(n)}` }
      )
    }
  }
  parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage })
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part)
      }
      controller.close()
    },
  })
}

/**
 * A v4 mock model, for the settings only an AI SDK v7 provider acts on.
 *
 * Mastra passes `reasoning` to v4 models and drops it for older ones, so which specification version
 * a test uses is the difference between a setting applied and a setting reported.
 */
export function mockModelV4(provider = 'openai', modelId = 'mock-v4'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider,
    modelId,
    doGenerate: async () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      } as never),
  })
}

/** The options of the model's `index`-th call. */
export function callAt(model: MockLanguageModelV3, index: number): LanguageModelV3CallOptions {
  return model.doGenerateCalls[index] as LanguageModelV3CallOptions
}

/** The system messages of the model's `index`-th call, in order. */
export function systemPrompt(model: MockLanguageModelV3, index = 0): string[] {
  return callAt(model, index)
    .prompt.filter((message) => message.role === 'system')
    .map((message) => message.content)
}

/** The tool declarations of the model's `index`-th call. */
export function toolsOf(model: MockLanguageModelV3, index = 0): Record<string, unknown>[] {
  return (callAt(model, index).tools ?? []) as unknown as Record<string, unknown>[]
}

/** Run an agent once and return its text, keeping the call site of every test to one line. */
export async function run(agent: Agent, prompt = 'hi'): Promise<string> {
  const result = await agent.generate(prompt)
  return result.text
}
