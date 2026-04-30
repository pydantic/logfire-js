import type { Evaluator } from './Evaluator'

export interface CaseOptions<Inputs, Output, Metadata = unknown> {
  evaluators?: readonly Evaluator<Inputs, Output, Metadata>[]
  expectedOutput?: Output
  inputs: Inputs
  metadata?: Metadata
  name?: string
}

/**
 * One example for a `Dataset` to evaluate. Holds inputs, an optional
 * expected output, free-form metadata, and any case-specific evaluators.
 */
export class Case<Inputs = unknown, Output = unknown, Metadata = unknown> {
  readonly evaluators: readonly Evaluator<Inputs, Output, Metadata>[]
  readonly expectedOutput?: Output
  readonly inputs: Inputs
  readonly metadata?: Metadata
  readonly name?: string

  constructor(opts: CaseOptions<Inputs, Output, Metadata>) {
    this.inputs = opts.inputs
    this.evaluators = opts.evaluators ?? []
    if (opts.name !== undefined) {
      this.name = opts.name
    }
    if (opts.expectedOutput !== undefined) {
      this.expectedOutput = opts.expectedOutput
    }
    if (opts.metadata !== undefined) {
      this.metadata = opts.metadata
    }
  }
}
