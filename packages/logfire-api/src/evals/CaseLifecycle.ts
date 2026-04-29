import type { Case } from './Case'
import type { ReportCase, ReportCaseFailure } from './reporting'
import type { EvaluatorContext } from './types'

/**
 * Per-case lifecycle hook. Pass the **class** (not an instance) to
 * `Dataset.evaluate({ lifecycle: MyLifecycle })` and the driver will
 * instantiate one per case.
 *
 * Mirrors pydantic-evals' `CaseLifecycle`.
 */
export abstract class CaseLifecycle<Inputs = unknown, Output = unknown, Metadata = unknown> {
  protected case: Case<Inputs, Output, Metadata>

  constructor(c: Case<Inputs, Output, Metadata>) {
    this.case = c
  }

  /**
   * Runs between the task and the evaluators. Return a (potentially modified)
   * `EvaluatorContext` to be passed to the evaluators.
   */
  prepareContext?(
    ctx: EvaluatorContext<Inputs, Output, Metadata>
  ): EvaluatorContext<Inputs, Output, Metadata> | Promise<EvaluatorContext<Inputs, Output, Metadata>>

  /** Runs before the task. Useful for setting up per-case state. */
  setup?(): Promise<void> | void

  /** Always runs, even when the task or an evaluator throws. */
  teardown?(result: ReportCase<Inputs, Output, Metadata> | ReportCaseFailure<Inputs, Output, Metadata>): Promise<void> | void
}

export type CaseLifecycleClass<Inputs = unknown, Output = unknown, Metadata = unknown> = new (
  c: Case<Inputs, Output, Metadata>
) => CaseLifecycle<Inputs, Output, Metadata>
