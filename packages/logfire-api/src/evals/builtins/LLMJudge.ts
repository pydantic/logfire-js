import type { EvaluationReason, EvaluatorContext, EvaluatorOutput } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/**
 * Per-output-channel config for `LLMJudge`. `false` disables the channel.
 */
export interface LLMJudgeOutputConfig {
  evaluationName?: string
  includeReason?: boolean
}

/**
 * The result of a judge invocation. Mirrors pydantic-evals'
 * `GradingOutput`-shaped dict.
 */
export interface JudgeResult {
  pass: boolean
  reason?: string
  score: number
}

export type JudgeFn = (args: {
  expectedOutput?: unknown
  inputs: unknown
  output: unknown
  rubric: string
}) => JudgeResult | Promise<JudgeResult>

let defaultJudge: JudgeFn | null = null

/**
 * Set a process-wide default judge for `LLMJudge` instances that don't pass
 * their own callback. Useful for shipping a single model client across all
 * evaluations.
 */
export function setDefaultJudge(fn: JudgeFn): void {
  defaultJudge = fn
}

export function getDefaultJudge(): JudgeFn | null {
  return defaultJudge
}

/**
 * LLM-as-judge evaluator. Takes a `rubric`, hands it (plus the case output and
 * optionally inputs / expected output) to a user-provided judge function, and
 * emits a score and/or assertion based on the judge's verdict.
 *
 * BYO judge (no model client is bundled with logfire-js). Either pass a
 * `judge` callback per instance or call `setDefaultJudge(fn)` once at startup.
 */
export class LLMJudge extends Evaluator {
  static evaluatorName = 'LLMJudge'

  readonly assertion: false | LLMJudgeOutputConfig
  readonly includeExpectedOutput: boolean
  readonly includeInput: boolean
  readonly judge?: JudgeFn
  readonly rubric: string
  readonly score: false | LLMJudgeOutputConfig

  constructor(opts: {
    assertion?: false | LLMJudgeOutputConfig
    includeExpectedOutput?: boolean
    includeInput?: boolean
    judge?: JudgeFn
    rubric: string
    score?: false | LLMJudgeOutputConfig
  }) {
    super()
    this.rubric = opts.rubric
    this.judge = opts.judge
    this.includeInput = opts.includeInput ?? false
    this.includeExpectedOutput = opts.includeExpectedOutput ?? false
    this.score = opts.score ?? { evaluationName: 'LLMJudge', includeReason: false }
    this.assertion = opts.assertion ?? { evaluationName: 'LLMJudge', includeReason: true }
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorOutput> {
    const judge = this.judge ?? defaultJudge
    if (judge === null) {
      throw new Error('LLMJudge: no judge callback provided. Pass `judge` to the constructor or call `setDefaultJudge(fn)`.')
    }
    const verdict = await judge({
      expectedOutput: this.includeExpectedOutput ? ctx.expectedOutput : undefined,
      inputs: this.includeInput ? ctx.inputs : undefined,
      output: ctx.output,
      rubric: this.rubric,
    })
    const out: Record<string, boolean | EvaluationReason | number> = {}
    if (this.score !== false) {
      const name = this.score.evaluationName ?? 'LLMJudge'
      out[name] = this.score.includeReason ? { reason: verdict.reason, value: verdict.score } : verdict.score
    }
    if (this.assertion !== false) {
      const name = this.assertion.evaluationName ?? 'LLMJudge'
      out[name] = this.assertion.includeReason ? { reason: verdict.reason, value: verdict.pass } : verdict.pass
    }
    return out
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { rubric: this.rubric }
    if (this.includeInput) out.include_input = true
    if (this.includeExpectedOutput) out.include_expected_output = true
    return out
  }
}
registerEvaluator(LLMJudge)
