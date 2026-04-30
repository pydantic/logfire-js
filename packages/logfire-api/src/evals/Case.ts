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
    this.name = opts.name
    this.inputs = opts.inputs
    this.expectedOutput = opts.expectedOutput
    this.metadata = opts.metadata
    this.evaluators = opts.evaluators ?? []
  }
}
