import type { LanguageModel, ToolSet } from 'ai'

import { codeMode } from '@pydantic/logfire-ai-sdk-code-mode'
import * as logfire from '@pydantic/logfire-node'
import { generateText, stepCountIs } from 'ai'

import { expenseTools, QUESTION } from './expenses.ts'

export async function reviewTravel(model: LanguageModel, tools: ToolSet = expenseTools): Promise<string> {
  return logfire.span('review travel', {}, {}, async () => {
    // One sandbox session for the whole run, so each run_code call sees what the earlier ones defined. codeMode()
    // starts nothing: the session is checked out on the first run_code call and joins the trace active here.
    // `await using` closes it when this callback returns or throws, like `await code.close()` in a finally block.
    await using code = codeMode({ tools })
    const { text } = await generateText({ model, prompt: QUESTION, tools: code.tools, stopWhen: stepCountIs(10) })
    return text
  })
}
