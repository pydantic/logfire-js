import type { EvaluationReason, EvaluatorContext, EvaluatorOutput } from '../types'

import { Evaluator } from '../Evaluator'
import { registerEvaluator } from '../registry'

/**
 * Per-output-channel config for `LLMJudge`. `false` disables the channel.
 */
export interface LLMJudgeOutputConfig {
  evaluation_name?: string
  evaluationName?: string
  include_reason?: boolean
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
  private readonly assertionWasProvided: boolean
  private readonly scoreWasProvided: boolean

  constructor(opts: {
    assertion?: false | LLMJudgeOutputConfig
    include_expected_output?: boolean
    include_input?: boolean
    includeExpectedOutput?: boolean
    includeInput?: boolean
    judge?: JudgeFn
    rubric: string
    score?: false | LLMJudgeOutputConfig
  }) {
    super()
    this.rubric = opts.rubric
    this.judge = opts.judge
    this.includeInput = opts.includeInput ?? opts.include_input ?? false
    this.includeExpectedOutput = opts.includeExpectedOutput ?? opts.include_expected_output ?? false
    this.scoreWasProvided = opts.score !== undefined
    this.assertionWasProvided = opts.assertion !== undefined
    this.score = opts.score === undefined || opts.score === false ? false : normalizeOutputConfig(opts.score)
    this.assertion =
      opts.assertion === undefined ? { includeReason: true } : opts.assertion === false ? false : normalizeOutputConfig(opts.assertion)
  }

  static jsonSchema(): Record<string, unknown> {
    const outputConfig = {
      additionalProperties: false,
      properties: {
        evaluation_name: { type: 'string' },
        include_reason: { type: 'boolean' },
      },
      type: 'object',
    }
    return {
      additionalProperties: false,
      properties: {
        assertion: { anyOf: [{ const: false, type: 'boolean' }, outputConfig] },
        include_expected_output: { default: false, type: 'boolean' },
        include_input: { default: false, type: 'boolean' },
        rubric: { type: 'string' },
        score: { anyOf: [{ const: false, type: 'boolean' }, outputConfig] },
      },
      required: ['rubric'],
      type: 'object',
    }
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
    const includeBoth = this.score !== false && this.assertion !== false
    const defaultName = this.getResultName()
    if (this.score !== false) {
      const name = outputConfigName(this.score) ?? (includeBoth ? `${defaultName}_score` : defaultName)
      out[name] = outputConfigIncludeReason(this.score) ? { reason: verdict.reason, value: verdict.score } : verdict.score
    }
    if (this.assertion !== false) {
      const name = outputConfigName(this.assertion) ?? (includeBoth ? `${defaultName}_pass` : defaultName)
      out[name] = outputConfigIncludeReason(this.assertion) ? { reason: verdict.reason, value: verdict.pass } : verdict.pass
    }
    return out
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { rubric: this.rubric }
    if (this.includeInput) out.include_input = true
    if (this.includeExpectedOutput) out.include_expected_output = true
    if (this.scoreWasProvided || this.score !== false) out.score = this.score === false ? false : outputConfigToJSON(this.score)
    if (this.assertionWasProvided || !isDefaultAssertionConfig(this.assertion)) {
      out.assertion = this.assertion === false ? false : outputConfigToJSON(this.assertion)
    }
    return out
  }
}
registerEvaluator(LLMJudge)

function normalizeOutputConfig(config: LLMJudgeOutputConfig): LLMJudgeOutputConfig {
  return {
    evaluationName: config.evaluationName ?? config.evaluation_name,
    includeReason: config.includeReason ?? config.include_reason,
  }
}

function outputConfigName(config: LLMJudgeOutputConfig): string | undefined {
  return config.evaluationName ?? config.evaluation_name
}

function outputConfigIncludeReason(config: LLMJudgeOutputConfig): boolean {
  return config.includeReason ?? config.include_reason ?? false
}

function outputConfigToJSON(config: LLMJudgeOutputConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const name = outputConfigName(config)
  if (name !== undefined) out.evaluation_name = name
  if (outputConfigIncludeReason(config)) out.include_reason = true
  return out
}

function isDefaultAssertionConfig(config: false | LLMJudgeOutputConfig): boolean {
  return config !== false && outputConfigName(config) === undefined && outputConfigIncludeReason(config)
}
