import type { LanguageModel } from 'ai'

import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import * as logfire from '@pydantic/logfire-node'
import { generateText, stepCountIs } from 'ai'

import { expenseTools } from './expenses.ts'
import { pythonStubs, runCode } from './runCode.ts'

export const PROMPT = `Which Engineering team members exceeded their Q3 travel budget?
The standard quarterly travel budget is $5,000, but some employees have a custom budget.
For anyone who spent more than $5,000, check for a custom budget and use it instead to decide whether they went over.`

export async function analyzeExpenses(model: LanguageModel): Promise<string> {
  // The sandbox session joins the trace that is active at checkout, so this span puts it in the agent run's trace.
  return logfire.span('analyze expenses', {}, {}, async () => {
    // One session for the whole run, so each run_code call sees what the earlier ones defined.
    await using pool = await agentSandboxes()
    await using session = await pool.checkout({
      ephemeral: true,
      scriptName: 'run_code.py',
      typeCheck: true,
      typeCheckStubs: pythonStubs(expenseTools),
    })
    const { text } = await generateText({
      model,
      prompt: PROMPT,
      tools: { run_code: runCode(session, expenseTools) },
      stopWhen: stepCountIs(5),
    })
    return text
  })
}
