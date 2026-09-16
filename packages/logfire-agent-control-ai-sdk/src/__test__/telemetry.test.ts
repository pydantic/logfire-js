import { context, propagation } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { generateText, streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { agentControl } from '../index'
import { captureWarnings, publishedValue, textResult, textStream, useLocalVariables } from './helpers'

captureWarnings()

// Baggage only propagates through a registered context manager, which in an application is what
// `logfire.configure()` installs. Registering one here is what makes the label observable at all.
const contextManager = new AsyncLocalStorageContextManager()
beforeAll(() => {
  contextManager.enable()
  context.setGlobalContextManager(contextManager)
})
afterAll(() => {
  context.disable()
  contextManager.disable()
})

/** The label the Logfire SDK put on the ambient context, as any span inside the run would carry it. */
function resolvedLabel(variableName: string): string | undefined {
  return propagation.getBaggage(context.active())?.getEntry(`logfire.variables.${variableName}`)?.value
}

/** A model that reports what the ambient context said while it was being called. */
function labelReadingModel(variableName: string, seen: (string | undefined)[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'anthropic.messages',
    modelId: 'claude-fable-5-1',
    doGenerate: async () => {
      seen.push(resolvedLabel(variableName))
      return Promise.resolve(textResult('ok'))
    },
    doStream: async () => {
      seen.push(resolvedLabel(variableName))
      return Promise.resolve(textStream('ok'))
    },
  })
}

describe('telemetry', () => {
  it('runs the model request inside the resolution, so a span says which value drove it', async () => {
    useLocalVariables(publishedValue('agent__labelled', { instructions: 'Be brief.' }, 'production'))
    const seen: (string | undefined)[] = []
    await generateText({
      model: agentControl({ model: labelReadingModel('agent__labelled', seen), name: 'labelled' }),
      prompt: 'hi',
    })
    const stream = streamText({
      model: agentControl({ model: labelReadingModel('agent__labelled', seen), name: 'labelled' }),
      prompt: 'hi',
    })
    await stream.text

    // The label the rollout chose, on both paths -- and gone again once the request is over.
    expect(seen).toEqual(['production', 'production'])
    expect(resolvedLabel('agent__labelled')).toBeUndefined()
  })

  it('says so when the agent is running on code rather than on a published value', async () => {
    useLocalVariables()
    const seen: (string | undefined)[] = []
    await generateText({
      model: agentControl({ model: labelReadingModel('agent__unlabelled', seen), name: 'unlabelled' }),
      prompt: 'hi',
    })

    expect(seen).toEqual(['<code_default>'])
  })
})
