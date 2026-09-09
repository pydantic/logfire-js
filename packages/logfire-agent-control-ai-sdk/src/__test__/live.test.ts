/**
 * What a real provider does with a managed config, recorded once and replayed offline.
 *
 * The rest of the suite drives the real AI SDK against a stub model, which proves what this adapter
 * puts on a request. It cannot prove what happens next -- whether a provider accepts a setting,
 * whether a model actually obeys a published instruction, whether a renamed tool comes back under
 * the name the README promises. Every such claim was read off provider source until these tests;
 * three of them turned out to be wrong, and the README's editability table now says so.
 *
 * Recorded with `node scripts/record-live-cassettes.mjs --env-file <path>`; see `cassette.ts` for the
 * recorder and what it stores. Replays need no credentials and make no network call.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { agentControl } from '../index'
import type { Cassette } from './cassette'
import { apiKey, cassette } from './cassette'
import { captureWarnings, publishedValue, useLocalVariables } from './helpers'

/** Recording talks to a real model over the network; replaying takes milliseconds. */
const LIVE_TIMEOUT = 120_000

/**
 * The cheapest current model of each provider that can still do everything under test.
 *
 * Each id was checked against its provider package's own model-id union rather than recalled: an id
 * the union does not list still typechecks, because every one of them ends in `(string & {})`.
 */
const OPENAI_MODEL = 'gpt-5.4-nano'
const ANTHROPIC_MODEL = 'claude-haiku-4-5'
const GOOGLE_MODEL = 'gemini-3.5-flash-lite'

// The AI SDK prints an `unsupported` warning to stderr for every setting a provider drops. These
// tests assert on that list instead, so the console copy is only noise.
;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

const warnings = captureWarnings()

const weather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string().describe('City name, e.g. `London`.') }),
  execute: async ({ city }: { city: string }) => Promise.resolve(`sunny in ${city}`),
})

/** The rename, the reworded description, and the reworded parameter description, in one override. */
const RENAME = {
  tool_definitions: [
    {
      name: 'get_weather',
      new_name: 'lookup_weather',
      description: 'Look up the current weather for a city.',
      parameters: { city: { description: "City name, e.g. 'London'." } },
    },
  ],
}

/** Every canonical setting a request can carry, so each provider's answer covers the whole table. */
const EVERY_SETTING = {
  max_tokens: 256,
  temperature: 0.1,
  top_p: 0.9,
  top_k: 20,
  seed: 7,
  presence_penalty: 0.1,
  frequency_penalty: 0.2,
  stop_sequences: ['STOP'],
  thinking: 'low',
  parallel_tool_calls: false,
  timeout: 60,
}

function openaiModel(tape: Cassette): ReturnType<ReturnType<typeof createOpenAI>> {
  return createOpenAI({ apiKey: apiKey('OPENAI_API_KEY'), fetch: tape.fetch })(OPENAI_MODEL)
}

function anthropicModel(tape: Cassette): ReturnType<ReturnType<typeof createAnthropic>> {
  return createAnthropic({ apiKey: apiKey('ANTHROPIC_API_KEY'), fetch: tape.fetch })(ANTHROPIC_MODEL)
}

function googleModel(tape: Cassette): ReturnType<ReturnType<typeof createGoogleGenerativeAI>> {
  // `GEMINI_API_KEY` is the name the key is stored under; `@ai-sdk/google` looks for
  // `GOOGLE_GENERATIVE_AI_API_KEY`, so it is passed rather than left to the provider's own lookup.
  return createGoogleGenerativeAI({ apiKey: apiKey('GEMINI_API_KEY'), fetch: tape.fetch })(GOOGLE_MODEL)
}

/** The n-th request body a cassette saw, as a bag this file can read keys out of. */
function sent(tape: Cassette, n = 0): Record<string, unknown> {
  return tape.requests()[n] as Record<string, unknown>
}

/** The `unsupported` features a provider reported for a call, which is its own list of what it dropped. */
function unsupported(list: readonly { type: string; feature?: string }[] | undefined): string[] {
  return (list ?? []).flatMap((entry) => (entry.type === 'unsupported' && entry.feature !== undefined ? [entry.feature] : []))
}

describe('live providers', () => {
  it(
    'sends a published instruction block to a real model, which obeys it',
    async () => {
      const tape = cassette('openai-instructions')
      useLocalVariables(
        publishedValue('agent__live_instructions', {
          instructions: [{ id: 'system:0', instructions: 'Reply with exactly one word: BANANA. No punctuation.' }],
        })
      )

      const { text } = await generateText({
        model: agentControl({
          model: openaiModel(tape),
          name: 'live_instructions',
          label: 'production',
          publishBaseline: false,
          codeInstructions: 'You are a helpful assistant. Always answer in a full sentence.',
        }),
        instructions: 'You are a helpful assistant. Always answer in a full sentence.',
        prompt: 'What is the capital of France?',
        maxRetries: 0,
      })

      // The published text is what the provider was sent, in place of the code's own.
      expect(sent(tape)['input']).toEqual([
        { role: 'developer', content: 'Reply with exactly one word: BANANA. No punctuation.' },
        { role: 'user', content: [{ type: 'input_text', text: 'What is the capital of France?' }] },
      ])
      // And it is what the model did, rather than the full sentence the code asked for.
      expect(text).toBe('BANANA')
    },
    LIVE_TIMEOUT
  )

  it(
    'renames a tool for a real model and un-renames it on the way back through `wrapGenerate`',
    async () => {
      const tape = cassette('anthropic-tools-generate')
      useLocalVariables(publishedValue('agent__live_tools_generate', RENAME))
      const executed: string[] = []

      const result = await generateText({
        model: agentControl({
          model: anthropicModel(tape),
          name: 'live_tools_generate',
          label: 'production',
          publishBaseline: false,
        }),
        instructions: 'You are a helpful assistant.',
        prompt: 'What is the weather in London? Use the tool.',
        tools: {
          get_weather: tool({
            description: 'Get the current weather for a city.',
            inputSchema: z.object({ city: z.string().describe('City name, e.g. `London`.') }),
            execute: async ({ city }: { city: string }) => {
              executed.push(city)
              return Promise.resolve(`sunny in ${city}`)
            },
          }),
        },
        stopWhen: stepCountIs(3),
        maxRetries: 0,
      })

      // The model is offered the managed name, the managed description, and the managed parameter
      // description -- all three, on one real request.
      expect(sent(tape)['tools']).toEqual([
        {
          name: 'lookup_weather',
          description: 'Look up the current weather for a city.',
          input_schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { city: { type: 'string', description: "City name, e.g. 'London'." } },
            required: ['city'],
            additionalProperties: false,
          },
        },
      ])

      // It called that name, and the code-side implementation ran with the arguments it sent.
      expect(executed).toEqual(['London'])

      // The next turn's history carries the managed name too, so the model is never shown a call to a
      // tool this request does not advertise.
      const history = sent(tape, 1)['messages'] as { role: string; content: { type: string; name?: string }[] }[]
      expect(history[1]?.content[0]).toMatchObject({ type: 'tool_use', name: 'lookup_weather' })
      expect(history[2]?.content[0]).toMatchObject({ type: 'tool_result' })

      // What the application sees is its own name, everywhere.
      expect(result.steps.flatMap((step) => step.content.flatMap((part) => ('toolName' in part ? [part.toolName] : [])))).toEqual([
        'get_weather',
        'get_weather',
      ])
      expect(result.text).toContain('sunny')
    },
    LIVE_TIMEOUT
  )

  it('renames a tool for a real model and un-renames it on the way back through `wrapStream`', async () => {
    const tape = cassette('anthropic-tools-stream')
    useLocalVariables(publishedValue('agent__live_tools_stream', RENAME))

    const stream = streamText({
      model: agentControl({
        model: anthropicModel(tape),
        name: 'live_tools_stream',
        label: 'production',
        publishBaseline: false,
      }),
      instructions: 'You are a helpful assistant.',
      prompt: 'What is the weather in London? Use the tool.',
      tools: { get_weather: weather },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    })

    const names: string[] = []
    for await (const part of stream.fullStream) {
      if ('toolName' in part) {
        names.push(part.toolName)
      }
    }

    // Every streamed part that names a tool names the code-side one, and the request that produced
    // them advertised the managed one.
    expect(new Set(names)).toEqual(new Set(['get_weather']))
    expect((sent(tape)['tools'] as { name: string }[])[0]?.name).toBe('lookup_weather')
    const history = sent(tape, 1)['messages'] as { content: { type: string; name?: string }[] }[]
    expect(history[1]?.content[0]).toMatchObject({ type: 'tool_use', name: 'lookup_weather' })
    expect(await stream.text).toContain('sunny')
  })

  // The point of these three: the adapter lowers all eleven canonical settings onto a request, and
  // what a *provider* then does with them is not the same question. Each of these records the answer.
  it(
    "applies the settings OpenAI's Responses API honours, and records the ones it drops",
    async () => {
      const tape = cassette('openai-settings')
      useLocalVariables(publishedValue('agent__live_openai_settings', { settings: EVERY_SETTING }))

      const result = await generateText({
        model: agentControl({
          model: openaiModel(tape),
          name: 'live_openai_settings',
          label: 'production',
          publishBaseline: false,
          codeInstructions: 'You are a helpful assistant.',
          codeSettings: { temperature: 0.5 },
        }),
        instructions: 'You are a helpful assistant.',
        prompt: 'What is the capital of France?',
        maxRetries: 0,
      })

      expect(sent(tape)['max_output_tokens']).toBe(256)
      expect(sent(tape)['parallel_tool_calls']).toBe(false)
      // `thinking: 'low'` reaches a v4 provider as an effort level and is accepted.
      expect(sent(tape)['reasoning']).toMatchObject({ effort: 'low' })
      // Everything else is dropped by the provider, not by this adapter: the AI SDK reports it on the
      // result, and Agent Control's own `onUnmatched` never sees it. See the README's known limits.
      expect(unsupported(result.warnings).sort()).toEqual([
        'frequencyPenalty',
        'presencePenalty',
        'seed',
        'stopSequences',
        'temperature',
        'topK',
        'topP',
      ])
    },
    LIVE_TIMEOUT
  )

  it(
    'applies the settings Anthropic honours, and records what enabling thinking costs',
    async () => {
      const tape = cassette('anthropic-settings')
      useLocalVariables(publishedValue('agent__live_anthropic_settings', { settings: EVERY_SETTING }))

      const result = await generateText({
        model: agentControl({
          model: anthropicModel(tape),
          name: 'live_anthropic_settings',
          label: 'production',
          publishBaseline: false,
          codeInstructions: 'You are a helpful assistant.',
          codeSettings: { temperature: 0.5 },
        }),
        instructions: 'You are a helpful assistant.',
        prompt: 'What is the capital of France?',
        maxRetries: 0,
      })

      expect(sent(tape)['stop_sequences']).toEqual(['STOP'])
      expect(sent(tape)['thinking']).toMatchObject({ type: 'enabled' })
      // A published `max_tokens` of 256 is *not* what Anthropic is asked for: the AI SDK raises the
      // ceiling to fit the thinking budget it derived from the same published `thinking`.
      expect(sent(tape)['max_tokens']).toBe(6656)
      expect(unsupported(result.warnings).sort()).toEqual(['frequencyPenalty', 'presencePenalty', 'seed', 'temperature', 'topK', 'topP'])
    },
    LIVE_TIMEOUT
  )

  it(
    'applies every setting Gemini honours, which is the most of the three',
    async () => {
      const tape = cassette('google-settings')
      useLocalVariables(
        publishedValue('agent__live_google_settings', {
          // The two Gemini rejects outright are left out here and tested on their own, below.
          settings: { ...EVERY_SETTING, presence_penalty: undefined, frequency_penalty: undefined },
        })
      )

      const result = await generateText({
        model: agentControl({
          model: googleModel(tape),
          name: 'live_google_settings',
          label: 'production',
          publishBaseline: false,
          codeInstructions: 'You are a helpful assistant.',
          codeSettings: { temperature: 0.5 },
        }),
        instructions: 'You are a helpful assistant.',
        prompt: 'What is the capital of France?',
        maxRetries: 0,
      })

      expect(sent(tape)['generationConfig']).toEqual({
        maxOutputTokens: 256,
        temperature: 0.1,
        topK: 20,
        topP: 0.9,
        stopSequences: ['STOP'],
        seed: 7,
        thinkingConfig: { thinkingLevel: 'low' },
      })
      expect(result.warnings).toEqual([])
      // `parallel_tool_calls` has no Gemini field, which the adapter itself reports.
      expect(warnings.messages).toContainEqual(expect.stringContaining("Managed agent config sets 'parallel_tool_calls'"))
    },
    LIVE_TIMEOUT
  )

  it(
    'lets a published setting fail a Gemini request outright, which nothing here can prevent',
    async () => {
      const tape = cassette('google-penalties')
      useLocalVariables(publishedValue('agent__live_google_penalties', { settings: { presence_penalty: 0.1 } }))

      // The strongest counter-example to "a published value can only ever be ignored": Gemini answers
      // 400 rather than dropping the field, so this published setting takes the agent down. It is in
      // the README's known limits, and it is why `onUnmatched` is not the whole story.
      await expect(
        generateText({
          model: agentControl({
            model: googleModel(tape),
            name: 'live_google_penalties',
            label: 'production',
            publishBaseline: false,
            codeInstructions: 'You are a helpful assistant.',
            codeSettings: {},
          }),
          instructions: 'You are a helpful assistant.',
          prompt: 'What is the capital of France?',
          maxRetries: 0,
        })
      ).rejects.toThrow(/Penalty is not enabled for this model/u)
    },
    LIVE_TIMEOUT
  )

  it(
    'resolves a published `google:` model through the provider the contract names',
    async () => {
      const tape = cassette('google-model-swap')
      useLocalVariables(publishedValue('agent__live_model_swap', { model: `google:${GOOGLE_MODEL}` }))
      // Never called, and so never needs a key: the published model is what answers.
      const code = createOpenAI({ apiKey: 'unused', fetch: tape.fetch })(OPENAI_MODEL)

      const { text } = await generateText({
        model: agentControl({
          model: code,
          name: 'live_model_swap',
          label: 'production',
          publishBaseline: false,
          providers: { google: createGoogleGenerativeAI({ apiKey: apiKey('GEMINI_API_KEY'), fetch: tape.fetch }) },
        }),
        instructions: 'You are a helpful assistant.',
        prompt: 'What is the capital of France? Answer in one word.',
        maxRetries: 0,
      })

      expect(text).toContain('Paris')
      // The one request this made went to Gemini, under the v2 spelling of its name.
      expect(sent(tape)['systemInstruction']).toEqual({ parts: [{ text: 'You are a helpful assistant.' }] })
      expect(warnings.messages).toContainEqual(expect.stringContaining(`in place of the code-defined 'openai:${OPENAI_MODEL}'`))
    },
    LIVE_TIMEOUT
  )
})
