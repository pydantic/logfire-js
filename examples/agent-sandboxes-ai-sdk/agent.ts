import type { LanguageModel, ToolSet } from 'ai'

import { toolStubs } from '@pydantic/logfire-code-mode'
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import * as logfire from '@pydantic/logfire-node'
import { generateText, stepCountIs } from 'ai'

import { expenseTools, QUESTION } from './expenses.ts'
import { runCode } from './runCode.ts'

export async function reviewTravel(model: LanguageModel, tools: ToolSet = expenseTools): Promise<string> {
  // The sandbox session joins the trace that is active at checkout, so this span puts it in the agent run's trace.
  return logfire.span('review travel', {}, {}, async () => {
    // One session for the whole run, so each run_code call sees what the earlier ones defined.
    await using pool = await agentSandboxes()
    await using session = await pool.checkout({
      ephemeral: true,
      scriptName: 'run_code.py',
      typeCheck: true,
      typeCheckStubs: toolStubs(tools).typeCheckStubs,
    })
    const { text } = await generateText({
      model,
      prompt: QUESTION,
      tools: { run_code: runCode(session, tools) },
      stopWhen: stepCountIs(10),
    })
    return text
  })
}
