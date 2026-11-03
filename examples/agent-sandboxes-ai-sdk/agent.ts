import type { LanguageModel } from 'ai'

import { generateText, stepCountIs } from 'ai'

import { expenseTools } from './expenses.ts'
import { runCode } from './runCode.ts'

export const PROMPT = `Which Engineering team members exceeded their Q3 travel budget?
The standard quarterly travel budget is $5,000, but some employees have a custom budget.
For anyone who spent more than $5,000, check for a custom budget and use it instead to decide whether they went over.`

export async function analyzeExpenses(model: LanguageModel): Promise<string> {
  const { text } = await generateText({
    model,
    prompt: PROMPT,
    tools: { run_code: runCode, ...expenseTools },
    experimental_toolCallers: {
      get_team_members: ['run_code'],
      get_expenses: ['run_code'],
      get_custom_budget: ['run_code'],
    },
    stopWhen: stepCountIs(5),
  })
  return text
}
