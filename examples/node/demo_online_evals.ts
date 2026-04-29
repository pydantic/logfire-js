/**
 * TypeScript port of `platform/scripts/demo_online_evals.py`.
 *
 * Wraps a stub "agent" function with `withOnlineEvaluation` and emits a
 * mixture of bool / float / string / failing evaluator outputs so the
 * `gen_ai.evaluation.result` log stream exercises every encoding shape the
 * Live Evaluations UI / materialized view has to handle.
 *
 * Usage:
 *   pnpm install
 *   pnpm demo-online-evals
 *
 * Then check the Live Evaluations UI for the targets `geography_agent` and
 * `math_agent` — http://localhost:3000/e2e-test/test-e2e-project/evals/live
 */

import * as logfire from '@pydantic/logfire-node'
import { Evaluator, type EvaluatorContext, type EvaluatorOutput, waitForEvaluations, withOnlineEvaluation } from 'logfire/evals'

logfire.configure({
  advanced: { baseUrl: process.env.LOGFIRE_BASE_URL ?? 'http://localhost:3000' },
  console: false,
  diagLogLevel: logfire.DiagLogLevel.NONE,
  environment: 'development',
  serviceName: 'online-evals-demo',
  token: process.env.LOGFIRE_TOKEN ?? 'test-e2e-write-token',
})

/** bool evaluator — exercises score.value + score.label dual representation. */
class NonEmpty extends Evaluator {
  static evaluatorName = 'NonEmpty'
  evaluate(ctx: EvaluatorContext): EvaluatorOutput {
    return Boolean(ctx.output)
  }
}

/** float evaluator — exercises score.value only. */
class LengthScore extends Evaluator {
  static evaluatorName = 'LengthScore'
  readonly targetLength: number
  constructor(targetLength = 40) {
    super()
    this.targetLength = targetLength
  }
  evaluate(ctx: EvaluatorContext): EvaluatorOutput {
    const text = String(ctx.output ?? '')
    const diff = Math.abs(text.length - this.targetLength)
    return Math.max(0, 1 - diff / this.targetLength)
  }
}

/** str evaluator — exercises score.label only (categorical). */
class Tone extends Evaluator {
  static evaluatorName = 'Tone'
  evaluate(ctx: EvaluatorContext): EvaluatorOutput {
    const text = String(ctx.output ?? '').toLowerCase()
    if (['sorry', 'apologize'].some((w) => text.includes(w))) return 'apologetic'
    if (['great', 'love', 'excellent'].some((w) => text.includes(w))) return 'enthusiastic'
    return 'neutral'
  }
}

/** Intentionally-failing evaluator — exercises the EvaluatorFailure path. */
class Flaky extends Evaluator {
  static evaluatorName = 'Flaky'
  readonly failureRate: number
  constructor(failureRate = 0.35) {
    super()
    this.failureRate = failureRate
  }
  evaluate(): EvaluatorOutput {
    if (Math.random() < this.failureRate) {
      throw new Error('flaky evaluator tripped')
    }
    return true
  }
}

const GEOGRAPHY_CASES: [string, string][] = [
  ['What is the capital of France?', 'The capital of France is Paris.'],
  ['What is the capital of Japan?', 'Tokyo.'],
  ['Largest country in South America?', "I'm sorry, I'm not sure — possibly Brazil."],
  ['Capital of Australia?', 'Canberra — a great but often-forgotten capital.'],
]

const MATH_CASES: [string, string][] = [
  ['What is 2 + 2?', '4'],
  ['Compute 15 * 17.', 'That would be 255 — a great multiplication example!'],
  ['Integrate x^2.', '(x^3)/3 + C'],
  ['Solve 0/0.', 'Sorry, that is undefined.'],
]

/**
 * Stub "agent" — returns the canned answer for a given prompt. Wraps the
 * actual function with `withOnlineEvaluation`.
 */
function buildRunner(targetName: string, cases: [string, string][]): (prompt: string) => Promise<string> {
  const answers = new Map(cases)

  // Wrap a plain async function — no model calls in the smoke test.
  const run = async (prompt: string): Promise<string> => {
    return logfire.span('agent.run', { prompt }, {}, async () => {
      // Small artificial delay so the call span has duration > 0.
      await new Promise((r) => setTimeout(r, 5))
      return answers.get(prompt) ?? '(unknown)'
    })
  }

  return withOnlineEvaluation(run, {
    evaluators: [new NonEmpty(), new LengthScore(40), new Tone(), new Flaky()],
    target: targetName,
  })
}

async function runTarget(targetName: string, cases: [string, string][]): Promise<void> {
  const runner = buildRunner(targetName, cases)
  for (const [prompt] of cases) {
    const out = await runner(prompt)
    console.log(`[${targetName}] ${JSON.stringify(prompt)} -> ${JSON.stringify(out)}`)
  }
}

await runTarget('geography_agent', GEOGRAPHY_CASES)
await runTarget('math_agent', MATH_CASES)

console.log('\nFlushing pending evaluations…')
await waitForEvaluations({ timeoutMs: 10_000 })
await logfire.forceFlush()
await logfire.shutdown()
console.log('Done. Open the Live Evaluations UI to confirm events landed for both targets.')
