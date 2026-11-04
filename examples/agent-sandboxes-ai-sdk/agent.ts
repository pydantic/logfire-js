import type { LanguageModel, ToolSet } from 'ai'

import { codeMode } from '@pydantic/logfire-code-mode'
import * as logfire from '@pydantic/logfire-node'
import { generateText, stepCountIs } from 'ai'

import { expenseTools, QUESTION } from './expenses.ts'

export async function reviewTravel(model: LanguageModel, tools: ToolSet = expenseTools): Promise<string> {
  return logfire.span('review travel', {}, {}, async () => {
    // One sandbox session for the whole run, so each run_code call sees what the earlier ones defined. It is checked
    // out on the first call and joins the trace that is active here. Leaving the block closes it.
    await using code = codeMode({ tools })
    const { text } = await generateText({ model, prompt: QUESTION, tools: code.tools, stopWhen: stepCountIs(10) })
    return text
  })
}
