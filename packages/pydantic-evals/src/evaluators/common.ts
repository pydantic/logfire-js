import { SpanQuery } from '../otel/spanTree'
import { EvaluatorContext } from './context'
import { EvaluationReason, evaluationReason, EvaluationScalar, Evaluator, EvaluatorOutput } from './evaluator'

function truncatedRepr(value: unknown, maxLength = 100): string {
  let s: string
  try {
    s = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s.length > maxLength) {
    return s.slice(0, Math.floor(maxLength / 2)) + '...' + s.slice(-Math.floor(maxLength / 2))
  }
  return s
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!deepEqual(aObj[k], bObj[k])) return false
  }
  return true
}

export class Equals extends Evaluator {
  readonly value: unknown

  constructor(params: { evaluationName?: string; value: unknown }) {
    super()
    this.value = params.value
    this.evaluationName = params.evaluationName
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return deepEqual(ctx.output, this.value)
  }
}

export class EqualsExpected extends Evaluator {
  constructor(params: { evaluationName?: string } = {}) {
    super()
    this.evaluationName = params.evaluationName
  }

  evaluate(ctx: EvaluatorContext): boolean | Record<string, boolean> {
    if (ctx.expectedOutput === null || ctx.expectedOutput === undefined) return {}
    return deepEqual(ctx.output, ctx.expectedOutput)
  }
}

export interface ContainsOptions {
  asStrings?: boolean
  caseSensitive?: boolean
  evaluationName?: string
  value: unknown
}

export class Contains extends Evaluator {
  readonly asStrings: boolean
  readonly caseSensitive: boolean
  readonly value: unknown

  constructor(params: ContainsOptions) {
    super()
    this.value = params.value
    this.caseSensitive = params.caseSensitive ?? true
    this.asStrings = params.asStrings ?? false
    this.evaluationName = params.evaluationName
  }

  evaluate(ctx: EvaluatorContext): EvaluationReason<boolean> {
    let failureReason: null | string = null
    const output = ctx.output
    const asStrings = this.asStrings || (typeof this.value === 'string' && typeof output === 'string')

    if (asStrings) {
      let outputStr = String(output)
      let expectedStr = String(this.value)
      if (!this.caseSensitive) {
        outputStr = outputStr.toLowerCase()
        expectedStr = expectedStr.toLowerCase()
      }
      if (!outputStr.includes(expectedStr)) {
        failureReason = `Output string ${truncatedRepr(outputStr)} does not contain expected string ${truncatedRepr(expectedStr)}`
      }
      return evaluationReason(failureReason === null, failureReason)
    }

    try {
      if (Array.isArray(output)) {
        if (!output.some((v) => deepEqual(v, this.value))) {
          failureReason = `Output ${truncatedRepr(output, 200)} does not contain provided value`
        }
      } else if (output !== null && typeof output === 'object') {
        const outputDict = output as Record<string, unknown>
        if (this.value !== null && typeof this.value === 'object' && !Array.isArray(this.value)) {
          const expectedDict = this.value as Record<string, unknown>
          for (const k of Object.keys(expectedDict)) {
            if (!(k in outputDict)) {
              failureReason = `Output does not contain expected key ${truncatedRepr(k, 30)}`
              break
            } else if (!deepEqual(outputDict[k], expectedDict[k])) {
              failureReason = `Output has different value for key ${truncatedRepr(k, 30)}: ${truncatedRepr(outputDict[k])} != ${truncatedRepr(expectedDict[k])}`
              break
            }
          }
        } else {
          if (typeof this.value !== 'string' || !(this.value in outputDict)) {
            failureReason = `Output ${truncatedRepr(outputDict, 200)} does not contain provided value as a key`
          }
        }
      } else {
        failureReason = `Output ${truncatedRepr(output, 200)} does not contain provided value`
      }
    } catch (e) {
      /* v8 ignore next - defensive catch for unexpected errors in containment check */
      failureReason = `Containment check failed: ${String(e)}`
    }

    return evaluationReason(failureReason === null, failureReason)
  }
}

export class IsInstance extends Evaluator {
  readonly typeName: string

  constructor(params: { evaluationName?: string; typeName: string }) {
    super()
    this.typeName = params.typeName
    this.evaluationName = params.evaluationName
  }

  evaluate(ctx: EvaluatorContext): EvaluationReason<boolean> {
    const output = ctx.output
    if (output === null || output === undefined) {
      return evaluationReason(false, `output is of type ${output === null ? 'null' : 'undefined'}`)
    }
    const ctor = (output as { constructor?: { name: string } }).constructor
    const name = ctor?.name ?? typeof output
    if (name === this.typeName) return evaluationReason(true)
    if (typeof output === this.typeName.toLowerCase()) return evaluationReason(true)
    return evaluationReason(false, `output is of type ${name}`)
  }
}

export class MaxDuration extends Evaluator {
  readonly seconds: number

  constructor(params: { seconds: number }) {
    super()
    this.seconds = params.seconds
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return ctx.duration <= this.seconds
  }
}

export interface OutputConfig {
  evaluationName?: string
  includeReason?: boolean
}

export interface GradingOutput {
  pass_: boolean
  reason: string
  score: number
}

export type JudgeFn = (params: {
  expectedOutput?: unknown
  inputs?: unknown
  output: unknown
  rubric: string
}) => GradingOutput | Promise<GradingOutput>

let defaultJudgeFn: JudgeFn | null = null

export function setDefaultJudgeFn(fn: JudgeFn | null): void {
  defaultJudgeFn = fn
}

export function getDefaultJudgeFn(): JudgeFn | null {
  return defaultJudgeFn
}

export interface LLMJudgeOptions {
  assertion?: false | OutputConfig
  evaluationName?: string
  includeExpectedOutput?: boolean
  includeInput?: boolean
  judge?: JudgeFn
  rubric: string
  score?: false | OutputConfig
}

export class LLMJudge extends Evaluator {
  readonly assertion: false | OutputConfig
  readonly includeExpectedOutput: boolean
  readonly includeInput: boolean
  readonly judge?: JudgeFn
  readonly rubric: string
  readonly score: false | OutputConfig

  constructor(params: LLMJudgeOptions) {
    super()
    this.rubric = params.rubric
    this.judge = params.judge
    this.includeInput = params.includeInput ?? false
    this.includeExpectedOutput = params.includeExpectedOutput ?? false
    this.score = params.score ?? false
    this.assertion = params.assertion ?? { includeReason: true }
    this.evaluationName = params.evaluationName
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorOutput> {
    const judge = this.judge ?? defaultJudgeFn
    if (judge === null || judge === undefined) {
      throw new Error('LLMJudge: no `judge` function provided and no default judge set. Call setDefaultJudgeFn() or pass `judge`.')
    }
    const grading = await judge({
      expectedOutput: this.includeExpectedOutput ? ctx.expectedOutput : undefined,
      inputs: this.includeInput ? ctx.inputs : undefined,
      output: ctx.output,
      rubric: this.rubric,
    })
    const output: Record<string, EvaluationReason | EvaluationScalar> = {}
    const includeBoth = this.score !== false && this.assertion !== false
    const evaluationName = this.getDefaultEvaluationName()

    if (this.score !== false) {
      const defaultName = includeBoth ? `${evaluationName}_score` : evaluationName
      this.applyOutput(output, grading.score, grading.reason, this.score, defaultName)
    }
    if (this.assertion !== false) {
      const defaultName = includeBoth ? `${evaluationName}_pass` : evaluationName
      this.applyOutput(output, grading.pass_, grading.reason, this.assertion, defaultName)
    }
    return output
  }

  private applyOutput(
    combined: Record<string, EvaluationReason | EvaluationScalar>,
    value: EvaluationScalar,
    reason: null | string,
    config: OutputConfig,
    defaultName: string
  ): void {
    const name = config.evaluationName ?? defaultName
    if (config.includeReason && reason !== null) {
      combined[name] = evaluationReason(value, reason)
    } else {
      combined[name] = value
    }
  }
}

export class HasMatchingSpan extends Evaluator {
  readonly query: SpanQuery

  constructor(params: { evaluationName?: string; query: SpanQuery }) {
    super()
    this.query = params.query
    this.evaluationName = params.evaluationName
  }

  evaluate(ctx: EvaluatorContext): boolean {
    return ctx.spanTree.any(this.query)
  }
}

export const DEFAULT_EVALUATORS = [Equals, EqualsExpected, Contains, IsInstance, MaxDuration, LLMJudge, HasMatchingSpan] as const
